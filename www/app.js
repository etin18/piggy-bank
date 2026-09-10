/* ==========================================================================
   存錢筒 — 應用程式邏輯

   資料流：本機是操作的即時真相，Google 試算表是同步目標。
   每筆變更先寫進本機（畫面立刻更新），再排隊送上試算表；
   沒網路時就留在佇列裡，等有網路自動補送。

   金額一律台幣。ETF 是台股，基金是台幣計價（計價幣別 TWD、匯率 1），
   所以整個 App 沒有任何匯率換算。
   ========================================================================== */

'use strict';

/* ---------- 常數 ---------- */

/** 改動 www/ 的內容時跟 sw.js 的 VERSION 一起加號，設定頁看得到，用來確認手機拿到的是不是新版 */
const APP_VERSION = 'v13';

const LS = {
  apiUrl: 'pb.apiUrl',
  secret: 'pb.secret',
  lastSync: 'pb.lastSync',
  theme: 'pb.theme',
  fields: 'pb.fields',    // 持股頁要顯示哪些資訊，只存在這台裝置
  apiVersion: 'pb.apiVersion',
  data: 'pb.',            // pb.instruments、pb.trades …
};

/**
 * 展開後那行小字要顯示哪些單價資訊。
 *
 * 投入、現值、配息、損益已經固定在損益拆解裡，不放進來讓人勾 ——
 * 那些是主結構，關掉的話拆解就不成立了。
 */
const HOLDING_FIELDS = [
  { key: 'avg', label: '平均成本', hint: '每單位' },
  { key: 'price', label: '現價／淨值', hint: '' },
  { key: 'rate', label: '匯率', hint: '美元計價才有' },
];

const DEFAULT_FIELDS = ['avg', 'price', 'rate'];

/** 五張表的名字，同步與本機儲存都照這個順序跑 */
const ENTITIES = ['instruments', 'trades', 'dividends', 'cashflows', 'prices'];

/** 期初持有的日期特殊值。排序時當成最早，年度統計時整筆略過 */
const PRE = 'PRE2025';
const PRE_LABEL = '2025 之前';

const ETF = 'ETF';
const FUND = '基金';

const BUY = '買進';
const SELL = '賣出';

const ACCOUNT_OF = { [ETF]: '券商', [FUND]: '基金' };

const MONTH_LABELS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];

/* ---------- 狀態 ---------- */

const state = {
  instruments: [],
  trades: [],
  dividends: [],
  cashflows: [],
  prices: [],

  apiUrl: '',
  secret: '',
  lastSync: null,
  apiVersion: '',        // 後端回報的版本，用來確認 Code.gs 有沒有重新部署
  syncing: false,
  lastError: null,

  theme: 'light',
  page: 'record',
  category: null,        // 記錄頁選中的 ETF / 基金
  reportYear: null,
  showClosed: false,     // 持股頁的「已出清」是否展開
  showAllRecent: false,  // 首頁的最近紀錄是否展開全部
  fields: DEFAULT_FIELDS.slice(),   // 持股卡片顯示哪些資訊
  detailId: null,        // 正在看明細的標的
  detailFilter: 'all',
  returnToDetail: null,  // 關掉編輯面板後要回到哪一檔的明細
  detailScroll: 0,       // 明細列表捲到哪，返回時停回原位
  expanded: new Set(),   // 持股頁展開了哪幾檔

  editing: null,         // { entity, id } 正在編輯的紀錄
  draft: {},             // 表單暫存：category、action、unit、style…
};

/* ==========================================================================
   小工具
   ========================================================================== */

const $ = (id) => document.getElementById(id);

function todayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function thisYear() {
  return new Date().getFullYear();
}

/** 日期字串的排序鍵。期初排在所有日期之前 */
function sortKey(date) {
  return date === PRE ? '0000-00-00' : String(date || '');
}

/** 'YYYY-MM-DD' → 年份數字；期初或空值回 null */
function yearOf(date) {
  if (!date || date === PRE) return null;
  const y = Number(String(date).slice(0, 4));
  return y || null;
}

function monthOf(date) {
  if (!date || date === PRE) return null;
  const m = Number(String(date).slice(5, 7));
  return m || null;
}

/** 今年省略年份，期初顯示「2025 之前」 */
function fmtDate(date) {
  if (!date) return '';
  if (date === PRE) return PRE_LABEL;
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  if (!y || !m || !d) return date;
  return y === thisYear() ? `${m}/${d}` : `${y}/${m}/${d}`;
}

/** 使用者可能連逗號一起貼上來，也可能留空 */
function parseNum(value) {
  if (value === null || value === undefined) return 0;
  const n = Number(String(value).replace(/[,\s$]/g, ''));
  return isFinite(n) ? n : 0;
}

function fmtMoney(n, { sign = false } = {}) {
  const v = Math.round(Number(n) || 0);
  const text = '$' + Math.abs(v).toLocaleString('en-US');
  if (v < 0) return '−' + text;
  return sign && v > 0 ? '+' + text : text;
}

/** 圖表上的小標籤，位數太多會擠成一團，所以上萬就縮寫 */
function fmtShort(n) {
  const v = Math.round(Number(n) || 0);
  if (!v) return '';
  if (Math.abs(v) >= 10000) {
    const w = v / 10000;
    return (Math.abs(w) >= 10 ? Math.round(w) : w.toFixed(1).replace(/\.0$/, '')) + '萬';
  }
  return v.toLocaleString('en-US');
}

/** 小數位數不固定：淨值 42.85、每單位配息 0.0855，都要保留原樣 */
function fmtNum(n, max = 4) {
  const v = Number(n) || 0;
  return v.toLocaleString('en-US', { maximumFractionDigits: max });
}

/** ETF 整張顯示「3 張」，畸零股顯示股數；基金一律單位數 */
function fmtQty(type, qty) {
  const v = Number(qty) || 0;
  if (type === FUND) return fmtNum(v, 4) + ' 單位';
  if (v >= 1000 && v % 1000 === 0) return fmtNum(v / 1000, 2) + ' 張';
  return fmtNum(v, 0) + ' 股';
}

/** ISO 時間戳 → 「9/9 09:05」，給「上次更新」用 */
function fmtStamp(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function escapeHtml(str) {
  return String(str === null || str === undefined ? '' : str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('is-open'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('is-open');
    setTimeout(() => { el.hidden = true; }, 220);
  }, 2400);
}

/* ==========================================================================
   本機儲存
   ========================================================================== */

function loadLocal() {
  try {
    state.apiUrl = localStorage.getItem(LS.apiUrl) || '';
    state.secret = localStorage.getItem(LS.secret) || '';
    state.lastSync = localStorage.getItem(LS.lastSync) || null;
    state.theme = localStorage.getItem(LS.theme) || 'light';
    state.apiVersion = localStorage.getItem(LS.apiVersion) || '';

    const saved = JSON.parse(localStorage.getItem(LS.fields) || 'null');
    if (Array.isArray(saved)) {
      // 過濾掉已經不存在的欄位名，免得改版後留下垃圾
      state.fields = saved.filter((k) => HOLDING_FIELDS.some((f) => f.key === k));
    }

    for (const entity of ENTITIES) {
      state[entity] = JSON.parse(localStorage.getItem(LS.data + entity) || '[]');
    }
  } catch (err) {
    console.warn('讀取本機資料失敗', err);
  }
}

function saveLocal() {
  try {
    for (const entity of ENTITIES) {
      localStorage.setItem(LS.data + entity, JSON.stringify(state[entity]));
    }
    if (state.lastSync) localStorage.setItem(LS.lastSync, state.lastSync);
  } catch (err) {
    toast('本機儲存空間不足');
  }
}

/* ==========================================================================
   API（Google Apps Script）
   ========================================================================== */

/**
 * 所有讀寫都走 POST，密語放在 body 裡（不放網址，免得出現在伺服器日誌）。
 * Content-Type 用 text/plain 讓瀏覽器當成「簡單請求」，
 * 才不會發出 Apps Script 無法回應的 OPTIONS 預檢。
 */
async function apiCall(payload) {
  const res = await fetch(state.apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...payload, secret: state.secret || '' }),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`連線失敗（${res.status}）`);
  const data = await res.json();

  // 後端每個回應都會帶版本，沒帶就是還沒更新的舊版
  state.apiVersion = data.apiVersion || '舊版';
  try { localStorage.setItem(LS.apiVersion, state.apiVersion); } catch (err) { /* 無妨 */ }

  if (!data.ok) {
    const err = new Error(data.error || '伺服器回報錯誤');
    if (data.authError) err.authError = true; // 密語錯誤，讓上層特別提示
    throw err;
  }
  return data;
}

/* ==========================================================================
   同步
   ========================================================================== */

function setSyncStatus(kind, text) {
  const chip = $('sync-chip');
  chip.className = 'sync-chip' + (kind ? ` is-${kind}` : '');
  $('sync-text').textContent = text;
}

function pendingCount() {
  return ENTITIES.reduce((sum, e) => sum + state[e].filter((r) => r._op).length, 0);
}

function refreshSyncChip() {
  const n = pendingCount();
  if (!state.apiUrl) return setSyncStatus('', '尚未設定');
  if (state.syncing) return setSyncStatus('busy', '同步中');
  if (n > 0) return setSyncStatus('wait', `${n} 筆待同步`);
  if (!navigator.onLine) return setSyncStatus('', '離線');
  return setSyncStatus('ok', '已同步');
}

/** 送上試算表的欄位，去掉 _op、_synced 這些只有本機用得到的標記 */
function payloadOf(record) {
  const out = {};
  for (const key of Object.keys(record)) {
    if (key.startsWith('_')) continue;
    out[key] = record[key];
  }
  return out;
}

/**
 * 先把本機佇列推上去，再拉回完整清單。
 * 推送失敗的項目保留 _op 標記，下次同步再試。
 */
async function sync({ silent = true } = {}) {
  if (!state.apiUrl) {
    refreshSyncChip();
    if (!silent) toast('請先到設定填入試算表網址');
    return false;
  }
  if (state.syncing) return false;
  if (!navigator.onLine) {
    refreshSyncChip();
    if (!silent) toast('目前離線，紀錄會先存在手機裡');
    return false;
  }

  state.syncing = true;
  refreshSyncChip();

  let hadError = null;

  try {
    for (const entity of ENTITIES) {
      for (const record of state[entity].filter((r) => r._op)) {
        try {
          if (record._op === 'delete') {
            // 只在伺服器上真的存在過才需要送刪除
            if (record._synced) await apiCall({ action: 'remove', entity, id: record.id });
            state[entity] = state[entity].filter((r) => r.id !== record.id);
          } else {
            await apiCall({ action: 'save', entity, record: payloadOf(record) });
            delete record._op;
            record._synced = true;
          }
        } catch (err) {
          if (/找不到這筆/.test(err.message)) {
            // 伺服器端已經沒有了：要刪的就當作刪成功，要改的改成新增補回去
            if (record._op === 'delete') {
              state[entity] = state[entity].filter((r) => r.id !== record.id);
            } else {
              record._op = 'create';
            }
          } else {
            hadError = err;
          }
        }
      }
    }

    // 拉回伺服器版本，疊上仍未同步的本機變更
    const data = await apiCall({ action: 'list' });
    for (const entity of ENTITIES) {
      state[entity] = mergeById(data[entity] || [], state[entity]);
    }
    state.lastSync = new Date().toISOString();
    saveLocal();
  } catch (err) {
    hadError = err;
  } finally {
    state.syncing = false;
  }

  render();
  refreshSyncChip();
  state.lastError = hadError || null;

  if (hadError) {
    setSyncStatus('error', hadError.authError ? '密語錯誤' : '同步失敗');
    if (!silent) toast(hadError.message || '同步失敗');
    return false;
  }
  return true;
}

/** 伺服器版本為底，本機還沒送出去的變更蓋在上面 */
function mergeById(serverRows, localRows) {
  const map = new Map(serverRows.map((r) => [r.id, { ...r, _synced: true }]));
  for (const local of localRows) {
    if (local._op) map.set(local.id, local);
  }
  return [...map.values()];
}

/* ==========================================================================
   資料存取
   ========================================================================== */

function live(entity) {
  return state[entity].filter((r) => r._op !== 'delete');
}

function instrumentById(id) {
  return state.instruments.find((i) => i.id === id) || null;
}

function instrumentName(id) {
  const inst = instrumentById(id);
  if (!inst) return '（已刪除的標的）';
  return inst.name || inst.code || '未命名';
}

function instrumentsOf(type) {
  return live('instruments')
    .filter((i) => i.type === type)
    .sort((a, b) => {
      // 已出清的沉到最後，其餘照代號、名稱排
      const closed = (x) => (x.status === '已出清' ? 1 : 0);
      if (closed(a) !== closed(b)) return closed(a) - closed(b);
      return String(a.code || a.name).localeCompare(String(b.code || b.name), 'zh-Hant');
    });
}

function typeOfTrade(record) {
  const inst = instrumentById(record.instrumentId);
  return inst ? inst.type : ETF;
}

function priceOf(instrumentId) {
  const row = live('prices').find((p) => p.id === instrumentId);
  return row ? Number(row.price) || 0 : 0;
}

function priceRow(instrumentId) {
  return live('prices').find((p) => p.id === instrumentId) || null;
}

/** 美元計價的基金，淨值是美元，換算台幣市值要乘匯率；台幣計價的一律 1 */
function isUsd(instrument) {
  return !!instrument && instrument.currency === 'USD';
}

function rateOf(instrumentId) {
  const inst = instrumentById(instrumentId);
  if (!isUsd(inst)) return 1;
  const row = priceRow(instrumentId);
  const rate = row ? Number(row.rate) || 0 : 0;
  return rate > 0 ? rate : 0;   // 還沒填匯率就算不出台幣市值
}

/**
 * 基金的單筆與定期定額在銀行是兩筆各自獨立的投資明細，各有各的平均淨值，
 * 所以要當成兩個部位分開算。ETF 不分。
 */
function normalizeStyle(style) {
  return style === '單筆' ? '單筆' : '小額';
}

function positionKey(instrumentId, type, style) {
  return type === FUND ? `${instrumentId}|${normalizeStyle(style)}` : instrumentId;
}

/** 某個日期（含）之前累積的持有量，配息表單用來自動帶入持有單位 */
function unitsHeldAt(instrumentId, date, style) {
  const limit = sortKey(date || todayStr());
  const inst = instrumentById(instrumentId);
  const isFund = inst && inst.type === FUND;

  return live('trades')
    .filter((t) => t.instrumentId === instrumentId && sortKey(t.date) <= limit)
    .filter((t) => !isFund || !style || normalizeStyle(t.style) === normalizeStyle(style))
    .reduce((sum, t) => sum + (t.action === SELL ? -Number(t.quantity) : Number(t.quantity)), 0);
}

/* ==========================================================================
   計算

   加權平均成本：買進累積金額 ÷ 買進累積數量。賣出不改變平均成本。
   手續費另外累加，攤進「含手續費的平均成本」——
   它只用來算損益，不影響對帳單上看到的平均淨值。
   ========================================================================== */

/** 數量小於這個就當成零 —— 基金單位數有小數，浮點運算會留下 0.0000001 這種尾巴 */
const EPS = 1e-6;

/**
 * 把一個部位的交易依時間切成一段一段的「持有回合」。
 * 持股歸零就結束一段，下次買進開新的一段、成本從零重新算 ——
 * 賣光之後買回來的那批，成本本來就跟賣掉的那批無關。
 *
 * 賣出時按當下的平均成本扣掉對應成本，所以部分賣出不會動到平均成本。
 */
function buildRounds(trades) {
  const sorted = trades.slice().sort((a, b) => {
    const cmp = sortKey(a.date).localeCompare(sortKey(b.date));
    return cmp || String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  });

  const rounds = [];
  let cur = null;

  const open = (date) => ({
    startDate: date,
    endDate: null,
    qty: 0,
    peakQty: 0,        // 這段期間最多持有過多少，已出清時顯示「曾持有」
    cost: 0,           // 含手續費，算損益用
    costExFee: 0,      // 不含手續費，對得上對帳單的平均成本
    fee: 0,
    realized: 0,
    dividends: 0,
    hasEstimate: false,
    closed: false,
  });

  for (const t of sorted) {
    const qty = Number(t.quantity) || 0;
    if (!cur) cur = open(t.date);

    if (t.action === SELL) {
      const avgCost = cur.qty > EPS ? cur.cost / cur.qty : 0;
      const avgExFee = cur.qty > EPS ? cur.costExFee / cur.qty : 0;
      const sold = Math.min(qty, cur.qty);

      // 錢是實收的全額，成本只能扣掉真正賣掉的那部分
      cur.realized += (Number(t.cash) || 0) - sold * avgCost;
      cur.cost -= sold * avgCost;
      cur.costExFee -= sold * avgExFee;
      cur.qty -= sold;

      if (cur.qty <= EPS) {
        cur.qty = 0;
        cur.cost = 0;
        cur.costExFee = 0;
        cur.closed = true;
        cur.endDate = t.date;
        rounds.push(cur);
        cur = null;
      }
    } else {
      cur.qty += qty;
      cur.cost += (Number(t.amount) || 0) + (Number(t.fee) || 0);
      cur.costExFee += Number(t.amount) || 0;
      cur.fee += Number(t.fee) || 0;
      cur.peakQty = Math.max(cur.peakQty, cur.qty);
      if (t.date === PRE) cur.hasEstimate = true;
    }
  }

  if (cur) rounds.push(cur);
  return rounds;
}

/**
 * 配息歸到對應的持有回合。
 * 用除息日判定（那天一定還持有），沒填才退回發放日；
 * 除息後才賣掉、賣掉之後才入帳的配息，會落在最後那一段裡。
 */
function assignDividends(rounds, dividends) {
  for (const d of dividends) {
    const date = d.exDate || d.payDate;
    let target = null;
    for (const round of rounds) {
      if (sortKey(round.startDate) <= sortKey(date)) target = round;
    }
    if (!target) target = rounds[0];
    if (target) target.dividends += Number(d.received) || 0;
  }
}

/**
 * 所有部位。ETF 一檔一個；基金一檔分「單筆」與「定期定額」兩個。
 * 每個部位帶著自己的持有回合，最後一段沒結束就是目前持有中的。
 */
function buildPositions() {
  const map = new Map();

  const ensure = (inst, style) => {
    const key = positionKey(inst.id, inst.type, style);
    if (!map.has(key)) {
      map.set(key, {
        key,
        instrument: inst,
        type: inst.type,
        style: inst.type === FUND ? normalizeStyle(style) : '',
        trades: [],
        dividends: [],
      });
    }
    return map.get(key);
  };

  for (const t of live('trades')) {
    const inst = instrumentById(t.instrumentId);
    if (inst) ensure(inst, t.style).trades.push(t);
  }

  for (const d of live('dividends')) {
    const inst = instrumentById(d.instrumentId);
    if (!inst) continue;

    // 配息的型態跟交易對不起來時（例如只記了配息還沒記交易），
    // 掛到這檔的第一個部位，至少不會憑空消失
    const key = positionKey(inst.id, inst.type, d.style);
    const position = map.get(key)
      || [...map.values()].find((p) => p.instrument.id === inst.id);
    if (position) position.dividends.push(d);
  }

  const positions = [];
  for (const position of map.values()) {
    const rounds = buildRounds(position.trades);
    assignDividends(rounds, position.dividends);

    const current = rounds.find((r) => !r.closed) || null;
    const closed = rounds.filter((r) => r.closed);
    const price = priceOf(position.instrument.id);
    const rate = rateOf(position.instrument.id);

    // 美元計價又還沒填匯率的話，算不出台幣市值，當成「沒有價格」處理
    const priced = price > 0 && rate > 0;

    const qty = current ? current.qty : 0;
    const cost = current ? current.cost : 0;
    const value = priced ? qty * price * rate : 0;

    positions.push({
      ...position,
      rounds,
      current,
      closed,
      qty,
      cost,
      price,
      rate,
      value,
      hasPrice: priced,
      avgPrice: current && current.qty > EPS ? current.costExFee / current.qty : 0,
      unrealized: priced ? value - cost : null,
      dividends: current ? current.dividends : 0,
      hasEstimate: current ? current.hasEstimate : false,
      pastRealized: closed.reduce((sum, r) => sum + r.realized, 0),
      allDividends: rounds.reduce((sum, r) => sum + r.dividends, 0),
    });
  }

  return positions;
}

/** 目前還持有的部位 */
function heldPositions() {
  return buildPositions().filter((p) => p.qty > EPS);
}

/** 已出清的每一段，新的在前面 */
function closedRounds() {
  const out = [];
  for (const position of buildPositions()) {
    for (const round of position.closed) {
      out.push({ position, round });
    }
  }
  return out.sort((a, b) => sortKey(b.round.endDate).localeCompare(sortKey(a.round.endDate)));
}

/**
 * 帳戶餘額 ＝ 期初 ＋ 存入 − 提領 ＋ 賣出實收 ＋ 配息實領 − 買進實扣
 * 兩個帳戶各算各的：ETF 走券商，基金走基金平台。
 *
 * 「2025 之前」的期初持股不扣款 —— 那筆錢在期初餘額被填進來之前
 * 早就付掉了，再扣一次會變成負的。
 */
function balanceOf(type) {
  const account = ACCOUNT_OF[type];
  let balance = 0;

  for (const c of live('cashflows')) {
    if (c.account !== account) continue;
    balance += c.action === '提領' ? -(Number(c.amount) || 0) : (Number(c.amount) || 0);
  }
  for (const t of live('trades')) {
    if (typeOfTrade(t) !== type || t.date === PRE) continue;
    balance += t.action === SELL ? (Number(t.cash) || 0) : -(Number(t.cash) || 0);
  }
  for (const d of live('dividends')) {
    if (typeOfTrade(d) !== type) continue;
    balance += Number(d.received) || 0;
  }
  return balance;
}

/** 某一年的配息，依發放日歸月。期初那些沒有日期的紀錄不會出現在這裡 */
function dividendStats(year) {
  const months = MONTH_LABELS.map(() => ({ [ETF]: 0, [FUND]: 0, total: 0 }));
  let etf = 0, fund = 0;

  for (const d of live('dividends')) {
    if (yearOf(d.payDate) !== year) continue;
    const m = monthOf(d.payDate);
    if (!m) continue;
    const amount = Number(d.received) || 0;
    const type = typeOfTrade(d);
    months[m - 1][type] += amount;
    months[m - 1].total += amount;
    if (type === FUND) fund += amount; else etf += amount;
  }

  return { months, etf, fund, total: etf + fund };
}

/** 今年只算到這個月為止，去年以前就是整整 12 個月 */
function monthsElapsed(year) {
  const now = new Date();
  if (year > now.getFullYear()) return 1;
  if (year < now.getFullYear()) return 12;
  return now.getMonth() + 1;
}

/** 有紀錄的年份，加上今年，新的在前面 */
function availableYears() {
  const years = new Set([thisYear()]);
  for (const d of live('dividends')) {
    const y = yearOf(d.payDate);
    if (y) years.add(y);
  }
  for (const t of live('trades')) {
    const y = yearOf(t.date);
    if (y) years.add(y);
  }
  return [...years].sort((a, b) => b - a);
}

/* ==========================================================================
   渲染
   ========================================================================== */

function render() {
  const page = state.page;
  $('page-record').hidden = page !== 'record';
  $('page-report').hidden = page !== 'report';
  $('page-holdings').hidden = page !== 'holdings';
  $('page-settings').hidden = page !== 'settings';

  for (const tab of document.querySelectorAll('.tab')) {
    const active = tab.dataset.page === page;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  $('btn-settings').classList.toggle('is-active', page === 'settings');

  const titles = { record: '存錢筒', report: '報表', holdings: '持股', settings: '設定' };
  $('topbar-title').textContent = titles[page] || '存錢筒';

  if (page === 'record') renderRecord();
  if (page === 'report') renderReport();
  if (page === 'holdings') renderHoldings();
  if (page === 'settings') renderSettings();
}

/* ---------- 記錄頁 ---------- */

function renderRecord() {
  const year = thisYear();
  const stats = dividendStats(year);
  const elapsed = monthsElapsed(year);

  $('summary-label').textContent = `${year} 年配息`;
  $('summary-total').textContent = fmtMoney(stats.total);
  $('summary-avg').textContent = fmtMoney(stats.total / elapsed);

  for (const btn of document.querySelectorAll('.picker__btn')) {
    btn.classList.toggle('is-active', btn.dataset.category === state.category);
  }

  const actions = $('actions');
  actions.hidden = !state.category;
  if (state.category) $('actions-title').textContent = state.category;

  renderRecent();
}

/** 首頁預設只列這麼多，其餘收在「查看全部」後面 */
const RECENT_LIMIT = 5;

function renderRecent() {
  const list = $('recent-list');
  const entries = recentEntries();
  const showAll = state.showAllRecent;
  const shown = showAll ? entries : entries.slice(0, RECENT_LIMIT);

  $('recent-title').textContent = state.category ? `最近的${state.category}紀錄` : '最近紀錄';
  $('record-empty').hidden = entries.length > 0 || live('trades').length > 0;

  list.innerHTML = shown.map(entryHtml).join('');

  const more = $('btn-recent-more');
  more.hidden = entries.length <= RECENT_LIMIT;
  more.classList.toggle('is-open', showAll);
  $('recent-more-text').textContent = showAll ? '收起' : `查看全部 ${entries.length} 筆`;
}

/** 三種紀錄混在一起，照日期新的在前 */
function recentEntries() {
  const cat = state.category;
  const out = [];

  for (const t of live('trades')) {
    if (cat && typeOfTrade(t) !== cat) continue;
    out.push({ kind: 'trade', record: t, date: t.date });
  }
  for (const d of live('dividends')) {
    if (cat && typeOfTrade(d) !== cat) continue;
    out.push({ kind: 'dividend', record: d, date: d.payDate });
  }
  for (const c of live('cashflows')) {
    if (cat && c.account !== ACCOUNT_OF[cat]) continue;
    out.push({ kind: 'cash', record: c, date: c.date });
  }

  return out.sort((a, b) => {
    const cmp = sortKey(b.date).localeCompare(sortKey(a.date));
    if (cmp) return cmp;
    return String(b.record.createdAt || '').localeCompare(String(a.record.createdAt || ''));
  });
}

function entryHtml(entry) {
  const r = entry.record;

  if (entry.kind === 'trade') {
    const inst = instrumentById(r.instrumentId);
    const type = inst ? inst.type : ETF;
    const isBuy = r.action !== SELL;
    const meta = [
      fmtDate(r.date),
      fmtQty(type, r.quantity),
      r.price ? `@ ${fmtNum(r.price, 4)}` : '',
      r.style || '',
    ].filter(Boolean).join(' · ');

    // 期初那筆沒有實際扣款，顯示金額只會讓人以為當天真的付了錢
    const amountHtml = r.date === PRE
      ? '<span class="entry__amount entry__amount--none">期初</span>'
      : `<span class="entry__amount ${isBuy ? 'entry__amount--out' : 'entry__amount--in'}">
           ${isBuy ? '−' : '+'}${fmtMoney(r.cash).replace('−', '')}
         </span>`;

    return `
      <button class="entry" type="button" data-entity="trades" data-id="${escapeHtml(r.id)}">
        <span class="entry__tag entry__tag--${isBuy ? 'buy' : 'sell'}">${isBuy ? '買' : '賣'}</span>
        <span class="entry__body">
          <span class="entry__name">${escapeHtml(instrumentName(r.instrumentId))}</span>
          <span class="entry__meta">${escapeHtml(meta)}</span>
        </span>
        ${amountHtml}
      </button>`;
  }

  if (entry.kind === 'dividend') {
    const meta = [fmtDate(r.payDate), r.perUnit ? `每單位 ${fmtNum(r.perUnit, 4)}` : '']
      .filter(Boolean).join(' · ');
    return `
      <button class="entry" type="button" data-entity="dividends" data-id="${escapeHtml(r.id)}">
        <span class="entry__tag entry__tag--div">息</span>
        <span class="entry__body">
          <span class="entry__name">${escapeHtml(instrumentName(r.instrumentId))}</span>
          <span class="entry__meta">${escapeHtml(meta)}</span>
        </span>
        <span class="entry__amount entry__amount--in">+${fmtMoney(r.received).replace('−', '')}</span>
      </button>`;
  }

  const isIn = r.action !== '提領';
  const meta = [fmtDate(r.date), r.account === '券商' ? '券商' : '基金平台', r.note || '']
    .filter(Boolean).join(' · ');
  return `
    <button class="entry" type="button" data-entity="cashflows" data-id="${escapeHtml(r.id)}">
      <span class="entry__tag entry__tag--cash">⇅</span>
      <span class="entry__body">
        <span class="entry__name">${isIn ? '存入' : '提領'}</span>
        <span class="entry__meta">${escapeHtml(meta)}</span>
      </span>
      <span class="entry__amount ${isIn ? 'entry__amount--in' : 'entry__amount--out'}">
        ${isIn ? '+' : '−'}${fmtMoney(r.amount).replace('−', '')}
      </span>
    </button>`;
}

/* ---------- 報表頁 ---------- */

function renderReport() {
  const years = availableYears();
  if (!state.reportYear || !years.includes(state.reportYear)) state.reportYear = years[0];
  const year = state.reportYear;

  $('year-bar').innerHTML = years.map((y) => `
    <button class="yearbar__btn ${y === year ? 'is-active' : ''}" type="button" data-year="${y}">
      ${y} 年
    </button>`).join('');

  const stats = dividendStats(year);
  const elapsed = monthsElapsed(year);

  $('rp-total').textContent = fmtMoney(stats.total);
  $('rp-avg').textContent = fmtMoney(stats.total / elapsed);
  $('rp-avg-label').textContent = year === thisYear()
    ? `平均每月（÷ ${elapsed} 個月）`
    : '平均每月（÷ 12）';
  $('rp-etf').textContent = fmtMoney(stats.etf);
  $('rp-fund').textContent = fmtMoney(stats.fund);

  renderChart(stats, year);

  $('bal-etf').textContent = fmtMoney(balanceOf(ETF));
  $('bal-fund').textContent = fmtMoney(balanceOf(FUND));

  const positions = buildPositions();
  const held = positions.filter((p) => p.qty > EPS);

  const cost = held.reduce((s, p) => s + p.cost, 0);
  const value = held.reduce((s, p) => s + (p.hasPrice ? p.value : p.cost), 0);

  // 已實現損益要算進所有回合，包含賣光之後又買回來的那些
  const realizedOf = (type) => positions
    .filter((p) => p.type === type)
    .reduce((sum, p) => sum + p.rounds.reduce((a, r) => a + r.realized, 0), 0);
  const realizedEtf = realizedOf(ETF);
  const realizedFund = realizedOf(FUND);

  const allDiv = live('dividends').reduce((s, d) => s + (Number(d.received) || 0), 0);
  // 基金的兩個部位共用同一個淨值，所以要照標的去重，不然會多算一次
  const missing = new Set(held.filter((p) => !p.hasPrice).map((p) => p.instrument.id)).size;

  $('rp-cost').textContent = fmtMoney(cost);
  $('rp-value').textContent = fmtMoney(value);
  setPL($('rp-unreal'), value - cost);
  setPL($('rp-real'), realizedEtf + realizedFund);
  $('rp-alldiv').textContent = fmtMoney(allDiv);

  $('rp-real-split').hidden = Math.round(realizedEtf + realizedFund) === 0;
  $('rp-real-etf').textContent = fmtMoney(realizedEtf, { sign: true });
  $('rp-real-fund').textContent = fmtMoney(realizedFund, { sign: true });

  const hint = $('rp-price-hint');
  hint.hidden = missing === 0;
  hint.textContent = missing
    ? `有 ${missing} 檔還沒填現價，市值先用成本計算 —— 到「持股」更新一下比較準。`
    : '';
}

function setPL(el, value) {
  const v = Math.round(value);
  el.textContent = fmtMoney(v, { sign: true });
  el.classList.toggle('is-gain', v > 0);
  el.classList.toggle('is-loss', v < 0);
}

function renderChart(stats, year) {
  const max = Math.max(...stats.months.map((m) => m.total), 1);
  const currentMonth = year === thisYear() ? new Date().getMonth() + 1 : 0;

  $('chart').innerHTML = stats.months.map((m, i) => {
    const height = m.total ? Math.max(4, (m.total / max) * 100) : 0;
    const etfPart = m.total ? (m[ETF] / m.total) * 100 : 0;
    const fundPart = m.total ? (m[FUND] / m.total) * 100 : 0;

    return `
      <div class="chart__col ${i + 1 === currentMonth ? 'is-current' : ''}">
        <span class="chart__value">${fmtShort(m.total)}</span>
        <div class="chart__bar" style="height:${height}%">
          <div class="chart__seg chart__seg--etf" style="height:${etfPart}%"></div>
          <div class="chart__seg chart__seg--fund" style="height:${fundPart}%"></div>
        </div>
        <span class="chart__label">${MONTH_LABELS[i]}</span>
      </div>`;
  }).join('');
}

/* ---------- 持股頁 ---------- */

function renderHoldings() {
  const positions = buildPositions();
  const held = positions.filter((p) => p.qty > EPS);

  const value = held.reduce((s, p) => s + (p.hasPrice ? p.value : p.cost), 0);
  const cost = held.reduce((s, p) => s + p.cost, 0);
  const dividends = held.reduce((s, p) => s + p.dividends, 0);

  // 跟每張卡片的主數字用同一種算法（含配息），
  // 不然上面寫「未實現」、下面寫「含息」，同一頁兩套標準會看不懂
  $('hd-value').textContent = fmtMoney(value);
  $('hd-cost').textContent = fmtMoney(cost);
  $('hd-div').textContent = fmtMoney(dividends);
  setPL($('hd-pl'), value - cost + dividends);

  const closed = closedRounds();
  $('holdings-empty').hidden = held.length > 0 || closed.length > 0;
  $('holdings-totals').hidden = held.length === 0;

  // 有 ETF 才顯示「更新現價」—— 基金沒有公開報價可抓。
  // 顯示設定那顆按鈕只要有持股就在
  const etfs = held.filter((p) => p.type === ETF);
  $('hold-tools').hidden = held.length === 0;
  $('btn-refresh-prices').hidden = etfs.length === 0;

  const stamps = etfs
    .map((p) => priceRow(p.instrument.id))
    .filter((row) => row && row.updatedAt)
    .map((row) => row.updatedAt)
    .sort();
  $('quote-hint').textContent = stamps.length
    ? `上次更新 ${fmtStamp(stamps[stamps.length - 1])}`
    : '從證交所抓，盤後是當日收盤';

  // 同一檔基金的單筆與定期定額要並在同一張卡片裡，所以先照標的收攏
  const cards = [];
  const byInstrument = new Map();
  for (const position of held) {
    const id = position.instrument.id;
    if (!byInstrument.has(id)) {
      const card = { instrument: position.instrument, type: position.type, lots: [] };
      byInstrument.set(id, card);
      cards.push(card);
    }
    byInstrument.get(id).lots.push(position);
  }

  const groups = [
    { type: ETF, rows: cards.filter((c) => c.type === ETF) },
    { type: FUND, rows: cards.filter((c) => c.type === FUND) },
  ].filter((g) => g.rows.length);

  $('holdings-list').innerHTML = groups.map((g) => `
    <p class="hold-group__title">${g.type}</p>
    ${g.rows.map(holdingHtml).join('')}
  `).join('');

  renderClosed(closed);
}

/** 損益數字 ＋ 報酬率，成本為零時不顯示百分比 */
function plHtml(amount, base, { cls = 'hold__pl' } = {}) {
  if (amount === null || amount === undefined) return `<span class="${cls} is-flat">—</span>`;
  const v = Math.round(amount);
  const tone = v > 0 ? 'is-gain' : (v < 0 ? 'is-loss' : 'is-flat');
  const pct = base ? (amount / base) * 100 : 0;
  const pctHtml = base
    ? `<small class="pl__pct">${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%</small>`
    : '';
  return `<span class="${cls} ${tone}">${fmtMoney(v, { sign: true })}${pctHtml}</span>`;
}

/**
 * 一檔一列，點了才展開細節。
 *
 * 收合時只有「名字 ＋ 賺賠多少」，一個畫面掃得完；
 * 展開後把損益拆成「價格漲跌 ＋ 配息」，
 * 不然像 0826 那種「價格在跌、配息補回來還有賺」的狀況，
 * 兩個顏色相反的數字並排會看不懂到底是賺是賠。
 */
function holdingHtml(card) {
  const inst = card.instrument;
  const isETF = card.type === ETF;
  const priceLabel = isETF ? '現價' : '淨值';
  const lots = card.lots;

  const qty = lots.reduce((s, p) => s + p.qty, 0);
  const cost = lots.reduce((s, p) => s + p.cost, 0);
  const dividends = lots.reduce((s, p) => s + p.dividends, 0);
  const past = lots.reduce((s, p) => s + p.pastRealized, 0);
  const value = lots.reduce((s, p) => s + p.value, 0);
  const hasPrice = lots[0].hasPrice;
  const price = lots[0].price;
  const rate = lots[0].rate;
  const usd = isUsd(inst);
  const hasEstimate = lots.some((p) => p.hasEstimate);

  const row = priceRow(inst.id);
  const updated = row && row.updatedAt ? fmtDate(String(row.updatedAt).slice(0, 10)) : '';

  const split = lots.length > 1;   // 同一檔基金既有單筆也有定期定額
  const singleStyle = !split && card.type === FUND ? styleLabel(lots[0].style) : '';
  const open = state.expanded.has(inst.id);

  const unrealized = value - cost;
  const total = unrealized + dividends;      // 含息，對得上對帳單的「參考損益」

  const tags = [
    singleStyle ? `<span class="hold__tag">${singleStyle}</span>` : '',
    usd ? '<span class="hold__tag hold__tag--usd">USD</span>' : '',
  ].join('');

  /* ---------- 收合時看到的那一列 ---------- */

  const headline = hasPrice
    ? `<span class="hold__amount ${toneOf(total)}">${fmtMoney(total, { sign: true })}</span>
       <span class="hold__pct ${toneOf(total)}">${fmtPct(total, cost)}</span>`
    : '<span class="hold__amount is-flat">—</span><span class="hold__pct is-flat">未填價</span>';

  const summary = [fmtQty(card.type, qty), hasPrice ? fmtMoney(value) : ''].filter(Boolean).join(' · ');

  /* ---------- 展開後的損益拆解 ---------- */

  const line = (label, value, extra = '') =>
    `<div class="split-row ${extra}"><span>${label}</span><span>${value}</span></div>`;

  const detail = [];

  if (hasPrice) {
    detail.push(`
      <div class="flow">
        <span class="flow__side"><small>投入</small>${fmtMoney(cost)}</span>
        <span class="flow__arrow" aria-hidden="true">→</span>
        <span class="flow__side flow__side--end"><small>現值</small>${fmtMoney(value)}</span>
      </div>`);

    detail.push(line('價格漲跌',
      `<b class="${toneOf(unrealized)}">${fmtMoney(unrealized, { sign: true })}
        <small>${fmtPct(unrealized, cost)}</small></b>`));
    detail.push(line('領到的配息', `<b>${fmtMoney(dividends)}</b>`));
    detail.push(line('合計',
      `<b class="${toneOf(total)}">${fmtMoney(total, { sign: true })}
        <small>${fmtPct(total, cost)}</small></b>`, 'split-row--total'));
  } else {
    detail.push(line('投入成本', `<b>${fmtMoney(cost)}</b>`));
    detail.push(line('領到的配息', `<b>${fmtMoney(dividends)}</b>`));
    detail.push(`<p class="hold__note">還沒填${priceLabel}，算不出市值和損益</p>`);
  }

  // 單價資訊放小字：知道成本和現價各是多少，但不搶主數字的版面
  const on = (key) => state.fields.includes(key);
  const facts = [];
  if (on('avg') && !split) {
    facts.push(`${usd ? '每單位成本' : '平均成本'} ${fmtNum(lots[0].avgPrice, usd ? 2 : 4)}`);
  }
  if (on('price')) facts.push(`${priceLabel} ${price > 0 ? fmtNum(price, 4) : '未填'}`);
  if (on('rate') && usd) facts.push(`匯率 ${rate > 0 ? fmtNum(rate, 4) : '未填'}`);
  if (facts.length) detail.push(`<p class="hold__facts">${escapeHtml(facts.join(' · '))}</p>`);

  if (split) detail.push(`<div class="lots">${lots.map((p) => lotHtml(p, hasPrice)).join('')}</div>`);

  const notes = [];
  if (hasEstimate) notes.push('含 2025 之前概估期初，成本僅供參考');
  if (Math.round(past) !== 0) notes.push(`過去已實現 ${fmtMoney(past, { sign: true })}`);
  if (notes.length) detail.push(`<p class="hold__note">${escapeHtml(notes.join(' · '))}</p>`);

  return `
    <div class="hold ${isETF ? 'hold--etf' : 'hold--fund'} ${open ? 'is-open' : ''}">
      <button class="hold__row" type="button" data-toggle-id="${escapeHtml(inst.id)}"
              aria-expanded="${open ? 'true' : 'false'}">
        <svg class="hold__caret" viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true">
          <path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span class="hold__main">
          <span class="hold__name">${escapeHtml(inst.name || '未命名')}${
            inst.code ? `<span class="hold__code">${escapeHtml(inst.code)}</span>` : ''
          }${tags}</span>
          <span class="hold__sub">${escapeHtml(summary)}</span>
        </span>
        <span class="hold__figures">${headline}</span>
      </button>

      <div class="hold__detail" ${open ? '' : 'hidden'}>
        ${detail.join('')}
        <div class="hold__foot">
          <button class="linkbtn" type="button" data-detail-id="${escapeHtml(inst.id)}">
            所有紀錄 ›
          </button>
          <button class="hold__price-btn ${hasPrice ? '' : 'is-missing'}" type="button"
                  data-price-id="${escapeHtml(inst.id)}">
            ${hasPrice ? `更新${priceLabel}${updated ? ` · ${updated}` : ''}` : `填${priceLabel}`}
          </button>
        </div>
      </div>
    </div>`;
}

function toneOf(amount) {
  const v = Math.round(amount);
  return v > 0 ? 'is-gain' : (v < 0 ? 'is-loss' : 'is-flat');
}

function fmtPct(amount, base) {
  if (!base) return '';
  const pct = (amount / base) * 100;
  return `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%`;
}

function styleLabel(style) {
  return style === '單筆' ? '單筆' : '定期定額';
}

function lotHtml(position, hasPrice) {
  const unrealized = hasPrice ? position.value - position.cost : null;
  const usd = isUsd(position.instrument);

  // 投入成本另起一行，第一行才不會擠。
  // 這裡不放報酬率，卡片上方已經有整檔的了
  const sub = [
    `投入 ${fmtMoney(position.cost)}`,
    `平均 ${fmtNum(position.avgPrice, usd ? 2 : 4)}`,
    hasPrice ? `市值 ${fmtMoney(position.value)}` : '',
  ].filter(Boolean).join(' · ');

  return `
    <div class="lot">
      <span class="lot__name">${styleLabel(position.style)}</span>
      <span class="lot__qty">${fmtQty(position.type, position.qty)}</span>
      <span class="lot__avg"></span>
      ${plHtml(unrealized, 0, { cls: 'lot__pl' })}
      <span class="lot__sub">${sub}</span>
    </div>`;
}

/** 已出清：預設收起來，上面那排數字才不會被歷史洗掉 */
function renderClosed(rounds) {
  const section = $('closed-section');
  section.hidden = rounds.length === 0;
  if (!rounds.length) return;

  const total = rounds.reduce((sum, r) => sum + r.round.realized, 0);
  $('closed-title').textContent =
    `已出清 ${rounds.length} 筆 · 已實現 ${fmtMoney(total, { sign: true })}`;

  $('btn-closed-toggle').setAttribute('aria-expanded', state.showClosed ? 'true' : 'false');
  $('btn-closed-toggle').classList.toggle('is-open', state.showClosed);
  $('closed-list').hidden = !state.showClosed;

  $('closed-list').innerHTML = rounds.map(({ position, round }) => {
    const inst = position.instrument;
    const tag = position.type === FUND ? `<span class="hold__tag">${styleLabel(position.style)}</span>` : '';
    const period = `${fmtDate(round.startDate)} – ${fmtDate(round.endDate)}`;
    const meta = [
      period,
      `曾持有 ${fmtQty(position.type, round.peakQty)}`,
      round.dividends ? `期間配息 ${fmtMoney(round.dividends)}` : '',
    ].filter(Boolean).join(' · ');

    return `
      <div class="closed__item">
        <div class="closed__head">
          <span class="closed__name hold__name--link" data-detail-id="${escapeHtml(inst.id)}"
                role="button" tabindex="0">${escapeHtml(inst.name || '未命名')}${
            inst.code ? `<span class="hold__code">${escapeHtml(inst.code)}</span>` : ''
          }${tag}</span>
          ${plHtml(round.realized, 0, { cls: 'closed__pl' })}
        </div>
        <div class="closed__meta">${escapeHtml(meta)}</div>
      </div>`;
  }).join('');
}

/* ---------- 設定頁 ---------- */

function renderSettings() {
  $('api-url').value = state.apiUrl;
  $('api-secret').value = state.secret;

  for (const chip of document.querySelectorAll('#theme-chips .chip')) {
    chip.classList.toggle('is-active', chip.dataset.themePref === state.theme);
  }

  $('stat-instruments').textContent = live('instruments').length;
  $('stat-trades').textContent = live('trades').length;
  $('stat-dividends').textContent = live('dividends').length;
  $('stat-cashflows').textContent = live('cashflows').length;
  $('stat-pending').textContent = pendingCount();
  $('stat-lastsync').textContent = state.lastSync
    ? new Date(state.lastSync).toLocaleString('zh-TW', { hour12: false }).replace(/:\d\d$/, '')
    : '—';

  // 前後端版本並排。兩邊對不起來的話，多半是 Code.gs 貼了但忘記重新部署，
  // 那會冒出一堆看起來莫名其妙的症狀（欄位存不進去、代號的 0 被吃掉）
  const api = state.apiVersion;
  const stale = api && api !== APP_VERSION;
  $('version-text').innerHTML = api
    ? `存錢筒 ${APP_VERSION} · 後端 ${escapeHtml(api)}${
        stale ? '<br><span class="version__warn">後端版本不符，請重新部署 Code.gs</span>' : ''
      }`
    : `存錢筒 ${APP_VERSION} · 資料存於你的 Google 試算表`;

  const list = live('instruments');
  $('instrument-list').innerHTML = list.length
    ? list.map((i) => `
        <button class="chip-list__item chip-list__item--${i.type === ETF ? 'etf' : 'fund'}
                ${i.status === '已出清' ? 'is-closed' : ''}"
                type="button" data-instrument-id="${escapeHtml(i.id)}">
          ${escapeHtml(i.code ? `${i.code} ${i.name}` : i.name)}
        </button>`).join('')
    : '<p class="chip-list__empty">還沒有標的</p>';
}

/* ==========================================================================
   標的明細：某一檔的所有買賣與配息
   ========================================================================== */

function openDetailSheet(instrumentId, { restoreScroll = false } = {}) {
  if (!instrumentById(instrumentId)) return;
  state.editing = null;   // 這是檢視用的面板，沒有在編輯任何一筆
  state.detailId = instrumentId;
  if (!restoreScroll) {
    state.detailFilter = 'all';
    state.detailScroll = 0;
  }

  renderDetail();
  openSheet('detail-sheet');

  // 從編輯面板回來時停回原本捲到的位置 —— 列表可能有幾十筆，
  // 每次都彈回最上面等於要重找一次
  const body = $('detail-sheet').querySelector('.sheet__body');
  requestAnimationFrame(() => { body.scrollTop = restoreScroll ? state.detailScroll : 0; });
}

/** 離開明細去編輯之前，記住是哪一檔、捲到哪，等一下要回來 */
function rememberDetailPosition() {
  state.returnToDetail = state.detailId;
  state.detailScroll = $('detail-sheet').querySelector('.sheet__body').scrollTop;
}

function detailEntries() {
  const id = state.detailId;
  const filter = state.detailFilter;
  const out = [];

  if (filter !== 'dividend') {
    for (const t of live('trades')) {
      if (t.instrumentId === id) out.push({ kind: 'trade', record: t, date: t.date });
    }
  }
  if (filter !== 'trade') {
    for (const d of live('dividends')) {
      if (d.instrumentId === id) out.push({ kind: 'dividend', record: d, date: d.payDate });
    }
  }

  return out.sort((a, b) => {
    const cmp = sortKey(b.date).localeCompare(sortKey(a.date));
    return cmp || String(b.record.createdAt || '').localeCompare(String(a.record.createdAt || ''));
  });
}

function renderDetail() {
  const inst = instrumentById(state.detailId);
  if (!inst) return;

  $('detail-sheet-title').textContent = inst.code ? `${inst.code} ${inst.name}` : (inst.name || '標的');

  const positions = buildPositions().filter((p) => p.instrument.id === inst.id);
  const qty = positions.reduce((s, p) => s + p.qty, 0);
  const cost = positions.reduce((s, p) => s + p.cost, 0);
  const value = positions.reduce((s, p) => s + p.value, 0);
  const dividends = positions.reduce((s, p) => s + p.allDividends, 0);
  const realized = positions.reduce(
    (s, p) => s + p.rounds.reduce((a, r) => a + r.realized, 0), 0
  );
  const hasPrice = positions.some((p) => p.hasPrice);

  const row = (label, value, wide) =>
    `<div class="detail-stats__row ${wide ? 'detail-stats__row--wide' : ''}">
       <span>${label}</span><strong>${value}</strong></div>`;

  const plRow = (label, amount, base) => {
    const v = Math.round(amount);
    const tone = v > 0 ? 'is-gain' : (v < 0 ? 'is-loss' : '');
    const pct = base ? ` <small>${v >= 0 ? '+' : '−'}${Math.abs((amount / base) * 100).toFixed(1)}%</small>` : '';
    return `<div class="detail-stats__row detail-stats__row--wide">
              <span>${label}</span><strong class="${tone}">${fmtMoney(v, { sign: true })}${pct}</strong></div>`;
  };

  const stats = [];
  if (qty > EPS) {
    stats.push(row('持有', fmtQty(inst.type, qty)));
    stats.push(row('投入成本', fmtMoney(cost)));
    if (hasPrice) stats.push(row('市值', fmtMoney(value)));
    stats.push(row('累計配息', fmtMoney(dividends)));
    if (hasPrice) stats.push(plRow('含息報酬', value - cost + dividends, cost));
  } else {
    stats.push(row('目前持有', '已出清'));
    stats.push(row('累計配息', fmtMoney(dividends)));
  }
  if (Math.round(realized) !== 0) stats.push(plRow('已實現損益', realized, 0));

  $('detail-stats').innerHTML = stats.join('');

  for (const chip of document.querySelectorAll('#detail-filter .chip')) {
    chip.classList.toggle('is-active', chip.dataset.detail === state.detailFilter);
  }

  const entries = detailEntries();
  $('detail-list').innerHTML = entries.map(entryHtml).join('');
  $('detail-empty').hidden = entries.length > 0;
}

/* ==========================================================================
   顯示哪些資訊
   ========================================================================== */

function openFieldsSheet() {
  renderFieldToggles();
  openSheet('fields-sheet');
}

function renderFieldToggles() {
  $('field-toggles').innerHTML = HOLDING_FIELDS.map((f) => `
    <label class="toggle field-toggle">
      <input type="checkbox" data-field="${f.key}" ${state.fields.includes(f.key) ? 'checked' : ''}>
      <span class="toggle__box" aria-hidden="true"></span>
      <span>${f.label}</span>
      ${f.hint ? `<span class="field-toggle__hint">${f.hint}</span>` : ''}
    </label>`).join('');
}

function saveFields() {
  try {
    localStorage.setItem(LS.fields, JSON.stringify(state.fields));
  } catch (err) {
    // 存不進去就只是這次有效，不影響顯示
  }
  renderHoldings();
}

/* ==========================================================================
   底部面板

   一次只開一個。開啟時鎖住背景捲動，關閉時把暫存清乾淨。
   ========================================================================== */

let openSheetId = null;

/**
 * 換面板時內部會先關掉舊的，那不是使用者按下的「關閉」，
 * 所以不該觸發「回到上一層」。
 */
let switchingSheet = false;

function openSheet(id) {
  switchingSheet = true;
  closeSheet(true);
  switchingSheet = false;

  openSheetId = id;
  const sheet = $(id);
  const scrim = $('scrim');

  sheet.hidden = false;
  scrim.hidden = false;
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => {
    sheet.classList.add('is-open');
    scrim.classList.add('is-open');
  });
}

function closeSheet(immediate = false) {
  if (!openSheetId) return;
  const sheet = $(openSheetId);
  const scrim = $('scrim');
  const id = openSheetId;
  openSheetId = null;

  sheet.classList.remove('is-open');
  scrim.classList.remove('is-open');
  document.body.style.overflow = '';

  const hide = () => {
    if (openSheetId !== id) { sheet.hidden = true; }
    if (!openSheetId) scrim.hidden = true;
  };
  if (immediate) { sheet.hidden = true; scrim.hidden = true; } else { setTimeout(hide, 240); }

  // 這裡不能清 state.editing。openSheet 會先呼叫這裡把上一個面板關掉，
  // 從「標的明細」點某筆進去編輯時，正在編輯的 id 會被清成 null，
  // 存檔就變成新增一筆。各個 open*Sheet 自己都會設好 editing，交給它們。

  // 從明細點進來的，關掉之後回明細，不要整個掉回持股頁
  if (!switchingSheet && state.returnToDetail) {
    const back = state.returnToDetail;
    state.returnToDetail = null;
    openDetailSheet(back, { restoreScroll: true });
  }
}

/* ---------- 往下拉關掉 ----------

   頂端那條橫槓，手機上直覺就是往下一撥把它收起來。

   只在「內容已經捲到最上面」或「從握把、標題列起手」時才接管手勢，
   不然使用者想往下看表單後半段，反而會把面板拉掉。
*/

const SHEET_CLOSE_PX = 110;   // 拉超過這個距離放手就關
const SHEET_FLING = 0.55;     // 或者甩得夠快（px/ms），距離不夠也關

function resetSheetDrag(sheet) {
  sheet.style.transition = '';
  sheet.style.transform = '';
  $('scrim').style.opacity = '';
}

function bindSheetDrag(sheet) {
  const body = sheet.querySelector('.sheet__body');

  let startY = 0;
  let dy = 0;
  let vy = 0;            // 最後一段的速度
  let lastY = 0;
  let lastT = 0;
  let dragging = false;
  let settled = false;   // 這次觸控算拖面板還是捲內容，判定過就不再改

  const inside = (t, sel) => t instanceof Element && !!t.closest(sel);

  sheet.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    startY = e.touches[0].clientY;
    lastY = startY;
    lastT = e.timeStamp;
    dy = 0;
    vy = 0;
    dragging = false;
    // 從輸入框起手不接管，不然選字會被吃掉
    settled = inside(e.target, 'input, textarea, select');
  }, { passive: true });

  sheet.addEventListener('touchmove', (e) => {
    if (settled && !dragging) return;
    const y = e.touches[0].clientY;
    const delta = y - startY;

    if (!dragging) {
      if (Math.abs(delta) < 6) return;   // 還看不出要往哪
      settled = true;
      const atTop = !body || body.scrollTop <= 0;
      const canDrag = delta > 0 && (inside(e.target, '.sheet__grip, .sheet__head') || atTop);
      if (!canDrag) return;              // 是要捲內容，讓瀏覽器自己處理
      dragging = true;
      sheet.style.transition = 'none';
    }

    // 只看最後一段的速度。用整段平均的話，「先慢慢拉一點、再往下一甩」
    // 會被前面的慢動作稀釋，甩了也關不掉
    const dt = e.timeStamp - lastT;
    if (dt >= 8) {                       // 取樣太密就先攢著，不然雜訊蓋過訊號
      vy = (y - lastY) / dt;
      lastY = y;
      lastT = e.timeStamp;
    }

    dy = Math.max(0, delta);
    e.preventDefault();                  // 攔下捲動，位置改由我們跟手
    sheet.style.transform = `translateY(${dy}px)`;
    $('scrim').style.opacity = String(Math.max(0, 1 - dy / (sheet.offsetHeight || 1)));
  }, { passive: false });

  const release = (e) => {
    if (!dragging) return;
    dragging = false;

    // 拉到一半停住再放手就不算甩，那時只看拉了多遠
    const flung = e.timeStamp - lastT < 120 && vy > SHEET_FLING;
    const shouldClose = dy > SHEET_CLOSE_PX || flung;

    // 先把 inline 樣式清掉，關閉動畫才接得上目前的位置繼續往下滑
    resetSheetDrag(sheet);
    if (shouldClose) closeSheet();
  };

  sheet.addEventListener('touchend', release);
  sheet.addEventListener('touchcancel', release);
}

function showError(id, message) {
  const el = $(id);
  el.textContent = message;
  el.hidden = !message;
}

/** 選項按鈕（chips）：同一組內只有一個是選中的 */
function setChips(containerId, attr, value) {
  for (const chip of document.querySelectorAll(`#${containerId} .chip`)) {
    chip.classList.toggle('is-active', chip.dataset[attr] === value);
  }
}

function chipValue(containerId, attr) {
  const active = document.querySelector(`#${containerId} .chip.is-active`);
  return active ? active.dataset[attr] : '';
}

/** 填入下拉的標的清單，順便處理「＋ 新增標的」那一項 */
function fillInstrumentSelect(selectId, type, selectedId) {
  const select = $(selectId);
  const list = instrumentsOf(type);

  select.innerHTML = [
    '<option value="">請選擇…</option>',
    ...list.map((i) => `
      <option value="${escapeHtml(i.id)}" ${i.id === selectedId ? 'selected' : ''}>
        ${escapeHtml(i.code ? `${i.code} ${i.name}` : i.name)}${i.status === '已出清' ? '（已出清）' : ''}
      </option>`),
    '<option value="__new">＋ 新增標的…</option>',
  ].join('');

  if (selectedId) select.value = selectedId;
}

/* ==========================================================================
   買進 / 賣出表單
   ========================================================================== */

function openTradeSheet({ category, action, record = null }) {
  state.draft = {
    category,
    action,
    unit: category === ETF ? '股' : '',
    style: category === FUND ? '小額' : '',
  };
  state.editing = record ? { entity: 'trades', id: record.id } : null;

  const isBuy = action === BUY;
  $('trade-sheet-title').textContent = `${category} · ${isBuy ? '買進' : '賣出'}`;
  $('btn-trade-delete').hidden = !record;
  showError('trade-error', '');

  fillInstrumentSelect('t-instrument', category, record ? record.instrumentId : '');

  // 欄位標籤與順序照各自的單據來排：
  //   ETF        券商的想法：數量 → 價格 → 金額
  //   台幣計價   銀行對帳單：金額 → 淨值 → 單位數
  //   美元計價   贖回／申購通知：單位數 → 淨值 → 匯率 → 台幣金額
  const isETF = category === ETF;
  const usd = isUsd(record ? instrumentById(record.instrumentId) : null)
    || (!record && isUsd(instrumentById($('t-instrument').value)));
  state.draft.usd = usd;

  layoutTradeFields(isETF, usd, isBuy);

  $('t-unit-chips').hidden = !isETF;
  $('t-style-field').hidden = isETF;

  if (record) {
    // 編輯既有紀錄：數量若剛好是整張就用「張」顯示，比較好核對
    const useLot = isETF && record.quantity >= 1000 && record.quantity % 1000 === 0;
    state.draft.unit = useLot ? '張' : '股';
    state.draft.style = record.style || (category === FUND ? '小額' : '');

    $('t-qty').value = useLot ? fmtNum(record.quantity / 1000, 3) : fmtNum(record.quantity, 4);
    $('t-price').value = record.price ? fmtNum(record.price, 6) : '';
    $('t-rate').value = record.rate && record.rate !== 1 ? fmtNum(record.rate, 4) : '';
    $('t-amount').value = record.amount ? fmtNum(record.amount, 2) : '';
    $('t-fee').value = record.fee ? fmtNum(record.fee, 2) : '';
    $('t-cash').value = record.cash ? fmtNum(record.cash, 2) : '';
    $('t-note').value = record.note || '';
    $('t-date').value = record.date === PRE ? '' : record.date;
    $('t-initial').checked = record.date === PRE;
    // 編輯時不要再自動覆寫使用者當初存的數字
    for (const id of ['t-qty', 't-amount', 't-cash']) $(id).dataset.auto = '0';
  } else {
    for (const id of ['t-qty', 't-price', 't-rate', 't-amount', 't-fee', 't-cash', 't-note']) $(id).value = '';
    $('t-date').value = todayStr();
    $('t-initial').checked = false;
    for (const id of ['t-qty', 't-amount', 't-cash']) $(id).dataset.auto = '1';
  }

  setChips('t-unit-chips', 'unit', state.draft.unit);
  setChips('t-style-chips', 'style', state.draft.style);
  syncTradeInitial();
  updateTradeHints();
  renderAmountQuick();

  openSheet('trade-sheet');
}

/**
 * 申購金額的快捷按鈕：從過去記過的金額挑幾個出來。
 * 定期定額每期都是同一個數字，點一下比重打快。
 *
 * 同一檔標的用過的排前面 —— 不同基金的每期金額往往不一樣。
 */
function recentAmounts(category, action, instrumentId, style, limit = 4) {
  const trades = live('trades')
    .filter((t) => typeOfTrade(t) === category && t.action === action && Number(t.amount) > 0)
    // 只看同一種型態：單筆通常是幾萬，定期定額是幾千，混在一起選項就沒用了
    .filter((t) => category !== FUND || normalizeStyle(t.style) === normalizeStyle(style))
    .sort((a, b) => {
      const cmp = sortKey(b.date).localeCompare(sortKey(a.date));
      return cmp || String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });

  const preferred = instrumentId ? trades.filter((t) => t.instrumentId === instrumentId) : [];

  const out = [];
  for (const t of [...preferred, ...trades]) {
    const amount = Number(t.amount);
    if (!out.includes(amount)) out.push(amount);
    if (out.length >= limit) break;
  }
  return out;
}

function renderAmountQuick() {
  const box = $('t-amount-quick');
  // 只有台幣計價的基金申購用得上：ETF 的成交金額跟著股價跑；
  // 美元計價的台幣金額是匯率換算出來的，每次都不一樣
  const useful = state.draft.category === FUND
    && state.draft.action === BUY
    && !state.draft.usd;

  const amounts = useful
    ? recentAmounts(FUND, BUY, $('t-instrument').value, chipValue('t-style-chips', 'style'))
    : [];

  box.hidden = amounts.length === 0;
  box.innerHTML = amounts
    .map((a) => `<button class="quick__btn" type="button" data-amount="${a}">${fmtNum(a, 2)}</button>`)
    .join('');
}

/** 期初持股不影響帳戶餘額，「帳戶實扣」那欄就沒有意義，收起來 */
function syncTradeInitial() {
  const on = $('t-initial').checked;
  syncInitialToggle('t-initial', 't-date', 't-initial-hint');
  $('t-cash').closest('.field').hidden = on;

  // 2025 之前的舊部位一律整筆算，不拆定期定額的每一期
  if (on && state.draft.category === FUND) {
    state.draft.style = '單筆';
    setChips('t-style-chips', 'style', '單筆');
    renderAmountQuick();
  }
}

/** 欄位順序與標籤。美元計價的基金多一格匯率，金額欄變成換匯後的台幣 */
function layoutTradeFields(isETF, usd, isBuy) {
  $('t-qty-field').style.order = isETF ? '1' : (usd ? '1' : '3');
  $('t-price-field').style.order = '2';
  $('t-rate-field').style.order = '3';
  $('t-amount-field').style.order = isETF ? '3' : '4';
  $('t-rate-field').hidden = !usd;

  $('t-qty-label').textContent = isETF ? '數量' : '單位數';
  $('t-price-label').textContent = isETF
    ? (isBuy ? '成交價' : '賣出價')
    : (usd ? (isBuy ? '申購淨值（美元）' : '贖回淨值（美元）') : '淨值');
  $('t-rate-label').textContent = isBuy ? '申購匯率' : '結匯匯率';
  $('t-amount-label').textContent = isETF
    ? '成交金額'
    : (usd ? '台幣金額' : (isBuy ? '申購金額' : '贖回金額'));

  $('t-cash-label').textContent = isBuy ? '帳戶實扣' : '帳戶實收';
  $('t-cash-hint').textContent = isBuy
    ? '自動帶入「金額＋手續費」，改成銀行實際扣款最準'
    : (usd
      ? '自動帶入「台幣金額−手續費」，對帳單上的「入帳淨額」最準'
      : '自動帶入「金額−手續費」，改成實際入帳金額最準');

  $('t-amount-hint').textContent = isETF
    ? ''
    : (usd ? '原幣金額 × 匯率，成本與損益都用這個台幣數字算' : '對帳單上的申購金額');
  $('t-fee-hint').textContent = usd
    ? '填台幣金額。算進成本，不影響部位價值'
    : '算進成本，不影響部位價值';
}

/** 勾了「2025 之前」就用不到日期欄了 */
function syncInitialToggle(toggleId, dateId, hintId) {
  const on = $(toggleId).checked;
  $(dateId).disabled = on;
  $(dateId).style.opacity = on ? '.45' : '';
  if (hintId) $(hintId).hidden = !on;
}

/**
 * 三個數字欄位互相推算。只動「還沒被手動改過」的欄位（dataset.auto === '1'），
 * 使用者一旦自己輸入，那欄就不再被蓋掉。
 */
/** 銀行是先把原幣金額四捨五入到分，再乘匯率，跟著做才對得上對帳單的尾數 */
function round2(n) {
  return Math.round(n * 100) / 100;
}

function recalcTrade(changed) {
  const isETF = state.draft.category === ETF;
  const usd = !!state.draft.usd;
  const isBuy = state.draft.action === BUY;

  if (changed) $(changed).dataset.auto = '0';

  const unitScale = state.draft.unit === '張' ? 1000 : 1;
  const qtyInput = parseNum($('t-qty').value);
  const qty = qtyInput * unitScale;
  const price = parseNum($('t-price').value);
  const rate = parseNum($('t-rate').value);
  const amount = parseNum($('t-amount').value);
  const fee = parseNum($('t-fee').value);

  let nextAmount = amount;

  if (isETF) {
    // 數量 × 價格 → 金額
    if ($('t-amount').dataset.auto === '1' && qty && price) {
      nextAmount = Math.round(qty * price);
      $('t-amount').value = fmtNum(nextAmount, 2);
    }
  } else if (usd) {
    // 單位數 × 淨值 × 匯率 → 台幣金額。
    // 中間不要先把原幣四捨五入（那樣 0.495×200.58×31.575 會變 3,135.08 而不是對帳單的 3,135），
    // 而且台幣入帳沒有小數，直接取整到元
    if ($('t-amount').dataset.auto === '1' && qty && price && rate) {
      nextAmount = Math.round(qty * price * rate);
      $('t-amount').value = fmtNum(nextAmount, 2);
    }
  } else {
    // 金額 ÷ 淨值 → 單位數
    if ($('t-qty').dataset.auto === '1' && amount && price) {
      $('t-qty').value = fmtNum(amount / price, 4);
    }
  }

  if ($('t-cash').dataset.auto === '1' && nextAmount) {
    const cash = isBuy ? nextAmount + fee : nextAmount - fee;
    $('t-cash').value = fmtNum(round2(cash), 2);
  }

  updateTradeHints();
}

function updateTradeHints() {
  const isETF = state.draft.category === ETF;
  const hint = $('t-qty-hint');

  // 美元計價：把原幣金額算給使用者看，對帳單上就有這個數字，可以直接核對
  const fxHint = $('t-fx-hint');
  if (state.draft.usd) {
    const qty = parseNum($('t-qty').value);
    const price = parseNum($('t-price').value);
    fxHint.textContent = qty && price
      ? `${fmtNum(qty, 4)} × ${fmtNum(price, 4)} ＝ 原幣金額 USD ${fmtNum(round2(qty * price), 2)}`
      : '';
    fxHint.classList.toggle('is-calc', !!(qty && price));
  } else {
    fxHint.textContent = '';
    fxHint.classList.remove('is-calc');
  }

  if (!isETF) { hint.textContent = ''; hint.classList.remove('is-calc'); return; }

  const unitScale = state.draft.unit === '張' ? 1000 : 1;
  const qty = parseNum($('t-qty').value) * unitScale;
  if (!qty) { hint.textContent = ''; hint.classList.remove('is-calc'); return; }

  hint.textContent = state.draft.unit === '張'
    ? `＝ ${fmtNum(qty, 0)} 股`
    : (qty % 1000 === 0 ? `＝ ${fmtNum(qty / 1000, 2)} 張` : `不足整張（1 張 ＝ 1000 股）`);
  hint.classList.add('is-calc');
}

function submitTrade() {
  const instrumentId = $('t-instrument').value;
  if (!instrumentId || instrumentId === '__new') return showError('trade-error', '請選擇標的');

  const isInitial = $('t-initial').checked;
  const date = isInitial ? PRE : $('t-date').value;
  if (!date) return showError('trade-error', '請選日期');

  const unitScale = state.draft.unit === '張' ? 1000 : 1;
  const quantity = parseNum($('t-qty').value) * unitScale;
  if (!quantity) return showError('trade-error', state.draft.category === ETF ? '請填數量' : '請填單位數');

  const amount = parseNum($('t-amount').value);
  const price = parseNum($('t-price').value);
  const fee = parseNum($('t-fee').value);
  const cashInput = $('t-cash').value.trim();
  const isBuy = state.draft.action === BUY;
  // 期初那筆的錢早就付掉了，記 0 才不會被算進帳戶餘額
  const cash = isInitial ? 0
    : (cashInput ? parseNum(cashInput) : (isBuy ? amount + fee : amount - fee));

  const inst = instrumentById(instrumentId);
  const rate = isUsd(inst) ? (parseNum($('t-rate').value) || 0) : 1;

  // 美元計價時 amount 存的是換匯後的台幣，成本與損益都用它算
  const fallbackAmount = price ? Math.round(quantity * price * (rate || 1)) : 0;

  const record = {
    id: state.editing ? state.editing.id : uuid(),
    instrumentId,
    code: inst ? (inst.code || inst.name) : '',
    date,
    action: isBuy ? BUY : SELL,
    style: state.draft.category === FUND ? chipValue('t-style-chips', 'style') : '',
    quantity,
    price,
    rate,
    amount: amount || fallbackAmount,
    fee,
    cash,
    note: $('t-note').value.trim(),
  };

  upsert('trades', record);
  closeSheet();
  toast(isBuy ? '記下買進' : '記下賣出');
}

/* ==========================================================================
   配息表單
   ========================================================================== */

function openDividendSheet({ category, record = null }) {
  state.draft = { category };
  state.editing = record ? { entity: 'dividends', id: record.id } : null;

  $('dividend-sheet-title').textContent = `${category} · 配息`;
  $('btn-dividend-delete').hidden = !record;
  showError('dividend-error', '');

  fillInstrumentSelect('d-instrument', category, record ? record.instrumentId : '');

  // 基金的單筆與定期定額配息分開發，ETF 不分
  $('d-style-field').hidden = category !== FUND;
  setChips('d-style-chips', 'dstyle', record ? normalizeStyle(record.style) : '小額');

  if (record) {
    $('d-exdate').value = record.exDate || '';
    $('d-paydate').value = record.payDate || '';
    $('d-perunit').value = record.perUnit ? fmtNum(record.perUnit, 6) : '';
    $('d-units').value = record.units ? fmtNum(record.units, 4) : '';
    $('d-received').value = record.received ? fmtNum(record.received, 2) : '';
    $('d-note').value = record.note || '';
    $('d-units').dataset.auto = '0';
  } else {
    $('d-exdate').value = '';
    $('d-paydate').value = todayStr();
    for (const id of ['d-perunit', 'd-units', 'd-received', 'd-note']) $(id).value = '';
    $('d-units').dataset.auto = '1';
  }

  updateDividendHints();
  openSheet('dividend-sheet');
}

/** 選了標的、填了除息日之後，自動帶入當時的持有單位 */
function autofillUnits() {
  if ($('d-units').dataset.auto !== '1') return;
  const instrumentId = $('d-instrument').value;
  if (!instrumentId || instrumentId === '__new') return;

  const date = $('d-exdate').value || $('d-paydate').value || todayStr();
  const style = state.draft.category === FUND ? chipValue('d-style-chips', 'dstyle') : '';
  const units = unitsHeldAt(instrumentId, date, style);
  $('d-units').value = units > 0 ? fmtNum(units, 4) : '';
}

function updateDividendHints() {
  const instrumentId = $('d-instrument').value;
  const inst = instrumentId && instrumentId !== '__new' ? instrumentById(instrumentId) : null;

  const freqHint = $('d-freq-hint');
  if (inst) {
    const last = live('dividends')
      .filter((d) => d.instrumentId === inst.id && d.payDate)
      .sort((a, b) => sortKey(b.payDate).localeCompare(sortKey(a.payDate)))[0];
    freqHint.textContent = [
      inst.frequency || '',
      last ? `上次配息 ${fmtDate(last.payDate)}` : '',
    ].filter(Boolean).join(' · ');
  } else {
    freqHint.textContent = '';
  }

  // 應發 vs 實領：差額就是被扣掉的稅費，讓使用者確認數字沒填錯
  const perUnit = parseNum($('d-perunit').value);
  const units = parseNum($('d-units').value);
  const received = parseNum($('d-received').value);
  const gross = perUnit * units;
  const taxHint = $('d-tax-hint');

  if (gross > 0) {
    let text;
    if (isUsd(inst)) {
      // 美元計價的每單位配息是美元，實領是換匯後的台幣。
      // 配息當天的匯率跟現在不一樣，硬要相減只會得到假的「稅費」，所以只做粗估
      const rate = rateOf(inst.id);
      text = rate > 0
        ? `應發約 ${fmtNum(gross, 2)} 美元（依目前匯率約 ${fmtMoney(gross * rate)}）`
        : `應發約 ${fmtNum(gross, 2)} 美元`;
    } else {
      const diff = gross - received;
      if (!received) text = `應發約 ${fmtMoney(gross)}`;
      else if (diff > 0.5) text = `應發 ${fmtMoney(gross)}，被扣 ${fmtMoney(diff)}（稅費）`;
      // 實領比應發多，通常是哪個數字填錯了 —— 講出來讓人回頭看一眼
      else if (diff < -0.5) text = `應發 ${fmtMoney(gross)}，實領多了 ${fmtMoney(-diff)}，確認一下`;
      else text = `應發 ${fmtMoney(gross)}，全額入帳`;
    }

    taxHint.textContent = text;
    taxHint.classList.add('is-calc');
  } else {
    taxHint.textContent = '';
    taxHint.classList.remove('is-calc');
  }
}

function submitDividend() {
  const instrumentId = $('d-instrument').value;
  if (!instrumentId || instrumentId === '__new') return showError('dividend-error', '請選擇標的');

  const payDate = $('d-paydate').value;
  if (!payDate) return showError('dividend-error', '請填發放日');

  const received = parseNum($('d-received').value);
  if (!received) return showError('dividend-error', '請填實領金額');

  const inst = instrumentById(instrumentId);
  const record = {
    id: state.editing ? state.editing.id : uuid(),
    instrumentId,
    code: inst ? (inst.code || inst.name) : '',
    style: inst && inst.type === FUND ? (chipValue('d-style-chips', 'dstyle') || '小額') : '',
    exDate: $('d-exdate').value || '',
    payDate,
    perUnit: parseNum($('d-perunit').value),
    units: parseNum($('d-units').value),
    received,
    note: $('d-note').value.trim(),
  };

  upsert('dividends', record);
  closeSheet();
  toast('記下配息');
}

/* ==========================================================================
   入金 / 出金表單
   ========================================================================== */

function openCashSheet({ category, record = null }) {
  state.draft = { category };
  state.editing = record ? { entity: 'cashflows', id: record.id } : null;

  $('cash-sheet-title').textContent = '入金出金';
  $('btn-cash-delete').hidden = !record;
  showError('cash-error', '');

  const account = record ? record.account : ACCOUNT_OF[category] || '券商';
  setChips('c-account-chips', 'account', account);
  setChips('c-action-chips', 'cashaction', record ? record.action : '存入');

  if (record) {
    $('c-date').value = record.date === PRE ? '' : record.date;
    $('c-initial').checked = record.date === PRE;
    $('c-amount').value = fmtNum(record.amount, 2);
    $('c-note').value = record.note || '';
  } else {
    $('c-date').value = todayStr();
    $('c-initial').checked = false;
    $('c-amount').value = '';
    $('c-note').value = '';
  }

  syncInitialToggle('c-initial', 'c-date');
  openSheet('cash-sheet');
}

function submitCash() {
  const isInitial = $('c-initial').checked;
  const date = isInitial ? PRE : $('c-date').value;
  if (!date) return showError('cash-error', '請選日期');

  const amount = parseNum($('c-amount').value);
  if (!amount) return showError('cash-error', '請填金額');

  const record = {
    id: state.editing ? state.editing.id : uuid(),
    date,
    account: chipValue('c-account-chips', 'account') || '券商',
    action: chipValue('c-action-chips', 'cashaction') || '存入',
    amount,
    note: $('c-note').value.trim(),
  };

  upsert('cashflows', record);
  closeSheet();
  toast(record.action === '存入' ? '記下存入' : '記下提領');
}

/* ==========================================================================
   標的表單
   ========================================================================== */

function openInstrumentSheet({ type, record = null, returnTo = null }) {
  state.draft = { returnTo };
  state.editing = record ? { entity: 'instruments', id: record.id } : null;

  $('instrument-sheet-title').textContent = record ? '編輯標的' : '新增標的';
  $('btn-instrument-delete').hidden = !record;
  $('i-status-field').hidden = !record;
  showError('instrument-error', '');

  setChips('i-type-chips', 'type', record ? record.type : (type || ETF));
  setChips('i-freq-chips', 'freq', record ? (record.frequency || '季配') : '季配');
  setChips('i-status-chips', 'status', record ? (record.status || '持有中') : '持有中');
  setChips('i-currency-chips', 'currency', record ? (record.currency || 'TWD') : 'TWD');

  $('i-code').value = record ? (record.code || '') : '';
  $('i-name').value = record ? (record.name || '') : '';

  syncCurrencyField();
  openSheet('instrument-sheet');
}

/** 台股 ETF 一定是台幣，只有基金要問計價幣別 */
function syncCurrencyField() {
  $('i-currency-field').hidden = chipValue('i-type-chips', 'type') !== FUND;
}

function submitInstrument() {
  const name = $('i-name').value.trim();
  if (!name) return showError('instrument-error', '請填名稱');

  const type = chipValue('i-type-chips', 'type') || ETF;
  const record = {
    id: state.editing ? state.editing.id : uuid(),
    code: $('i-code').value.trim(),
    name,
    type,
    // 台股 ETF 一律台幣
    currency: type === FUND ? (chipValue('i-currency-chips', 'currency') || 'TWD') : 'TWD',
    frequency: chipValue('i-freq-chips', 'freq') || '',
    status: state.editing ? (chipValue('i-status-chips', 'status') || '持有中') : '持有中',
    note: '',
  };

  const returnTo = state.draft.returnTo;
  upsert('instruments', record);
  closeSheet();

  // 從交易或配息表單按「＋ 新增標的」進來的，存完就回去並自動選好
  if (returnTo === 'trade') {
    openTradeSheet({ category: record.type, action: state.draft.action || BUY });
    fillInstrumentSelect('t-instrument', record.type, record.id);
  } else if (returnTo === 'dividend') {
    openDividendSheet({ category: record.type });
    fillInstrumentSelect('d-instrument', record.type, record.id);
    autofillUnits();
    updateDividendHints();
  } else {
    toast('標的已儲存');
  }
}

function deleteInstrument(id) {
  const used = live('trades').some((t) => t.instrumentId === id)
    || live('dividends').some((d) => d.instrumentId === id);

  if (used) {
    toast('這個標的還有紀錄，請改成「已出清」');
    return;
  }
  remove('instruments', id);
  remove('prices', id);
  closeSheet();
  toast('標的已刪除');
}

/* ==========================================================================
   現價表單
   ========================================================================== */

function openPriceSheet(instrumentId) {
  const inst = instrumentById(instrumentId);
  if (!inst) return;

  state.draft = { priceId: instrumentId };
  state.editing = null;
  showError('price-error', '');

  const isETF = inst.type === ETF;
  const usd = isUsd(inst);

  $('p-name').textContent = inst.code ? `${inst.code} ${inst.name}` : inst.name;
  $('p-label').textContent = isETF ? '現在股價' : (usd ? '最新淨值（美元）' : '最新淨值');
  $('p-hint').textContent = isETF
    ? '看券商 App 或股價網站的收盤價'
    : '看銀行對帳單或基金平台的最新淨值';

  const row = priceRow(instrumentId);
  $('p-price').value = row && row.price ? fmtNum(row.price, 6) : '';

  // 美元計價的基金要連匯率一起記，不然算不出台幣市值
  $('p-rate-field').hidden = !usd;
  $('p-rate').value = row && row.rate ? fmtNum(row.rate, 4) : '';

  // 只有填了代號的 ETF 抓得到報價
  $('btn-fetch-price').hidden = !(isETF && String(inst.code || '').trim());
  $('p-hint').classList.remove('is-calc');

  updatePricePreview();
  openSheet('price-sheet');
}

/** 邊填邊試算台幣市值，數字填錯（例如淨值和匯率填反）一眼就看得出來 */
function updatePricePreview() {
  const box = $('p-preview');
  const inst = instrumentById(state.draft.priceId);
  const price = parseNum($('p-price').value);
  const rate = isUsd(inst) ? parseNum($('p-rate').value) : 1;

  const qty = inst ? heldPositions()
    .filter((p) => p.instrument.id === inst.id)
    .reduce((sum, p) => sum + p.qty, 0) : 0;

  if (!price || !rate || !qty) {
    box.hidden = true;
    return;
  }

  const value = qty * price * rate;
  box.hidden = false;
  box.textContent = isUsd(inst)
    ? `${fmtNum(qty, 4)} 單位 × ${fmtNum(price, 4)} × ${fmtNum(rate, 4)} ＝ 市值 ${fmtMoney(value)}`
    : `${fmtNum(qty, 4)} × ${fmtNum(price, 4)} ＝ 市值 ${fmtMoney(value)}`;
}

function submitPrice() {
  const instrumentId = state.draft.priceId;
  const price = parseNum($('p-price').value);
  if (!price) return showError('price-error', '請填價格');

  const inst = instrumentById(instrumentId);
  const usd = isUsd(inst);
  const rate = usd ? parseNum($('p-rate').value) : 1;
  if (usd && !rate) return showError('price-error', '美元計價的基金要填參考匯率');

  upsert('prices', {
    id: instrumentId,
    code: inst ? (inst.code || inst.name) : '',
    price,
    rate,
    updatedAt: new Date().toISOString(),
  });

  closeSheet();
  toast('已更新');
}

/* ==========================================================================
   自動抓現價

   瀏覽器不能直接抓證交所（跨網域會被擋），所以繞到自己的 Apps Script 代抓。
   基金沒有公開的淨值 API，維持手動填。
   ========================================================================== */

async function fetchQuotes(codes) {
  if (!state.apiUrl) throw new Error('請先到設定連線試算表');
  if (!navigator.onLine) throw new Error('目前離線，連不到報價');
  const data = await apiCall({ action: 'quotes', codes });
  return data.quotes || {};
}

/** 目前持有、而且填了代號的 ETF —— 沒代號查不了，沒持股也不需要 */
function quotableEtfs() {
  return heldPositions()
    .filter((p) => p.type === ETF)
    .map((p) => p.instrument);
}

async function refreshEtfPrices() {
  const all = quotableEtfs();
  const targets = all.filter((i) => String(i.code || '').trim());

  if (!targets.length) {
    toast(all.length ? '請先幫 ETF 填代號' : '沒有持有中的 ETF');
    return;
  }

  const btn = $('btn-refresh-prices');
  btn.disabled = true;
  $('quote-btn-text').textContent = '查詢中…';

  try {
    const quotes = await fetchQuotes(targets.map((i) => i.code));

    const failed = [];
    let updated = 0;
    let source = '';
    let time = '';

    for (const inst of targets) {
      const quote = quotes[String(inst.code).trim().toUpperCase()];
      if (!quote || !quote.price) {
        failed.push(inst.code);
        continue;
      }
      upsert('prices', {
        id: inst.id,
        code: inst.code,
        price: quote.price,
        rate: 1,          // 台股一律台幣
        updatedAt: new Date().toISOString(),
      }, { flush: false });
      updated++;
      source = source || quote.source || '';
      time = time || quote.time || '';
    }

    flushChanges();

    if (!updated) {
      toast(`查不到報價：${failed.join('、')}`);
    } else if (failed.length) {
      toast(`更新 ${updated} 檔，查不到 ${failed.join('、')}`);
    } else {
      toast(`已更新 ${updated} 檔 · ${source}${time ? ` ${time}` : ''}`);
    }
  } catch (err) {
    toast(err.message || '查詢失敗');
  } finally {
    btn.disabled = false;
    $('quote-btn-text').textContent = '更新 ETF 現價';
    renderHoldings();
  }
}

/** 現價表單裡的單檔抓取 */
async function fetchOnePrice() {
  const inst = instrumentById(state.draft.priceId);
  if (!inst) return;

  const code = String(inst.code || '').trim();
  if (!code) return showError('price-error', '這檔沒有填代號，請手動輸入價格');

  const btn = $('btn-fetch-price');
  btn.disabled = true;
  $('fetch-price-text').textContent = '查詢中…';
  showError('price-error', '');

  try {
    const quotes = await fetchQuotes([code]);
    const quote = quotes[code.toUpperCase()];
    if (!quote || !quote.price) {
      showError('price-error', `查不到 ${code} 的報價，請手動輸入`);
      return;
    }
    $('p-price').value = fmtNum(quote.price, 4);
    $('p-hint').textContent = `${quote.source}${quote.time ? ` · ${quote.time}` : ''}`;
    $('p-hint').classList.add('is-calc');
  } catch (err) {
    showError('price-error', err.message || '查詢失敗');
  } finally {
    btn.disabled = false;
    $('fetch-price-text').textContent = '自動抓取';
  }
}

/* ==========================================================================
   寫入（本機先行，再排隊同步）
   ========================================================================== */

/** 存檔、重畫、排隊同步。批次寫入時最後呼叫一次就好 */
function flushChanges() {
  saveLocal();
  render();
  refreshSyncChip();
  sync();
}

function upsert(entity, record, { flush = true } = {}) {
  const list = state[entity];
  const index = list.findIndex((r) => r.id === record.id);

  if (index === -1) {
    list.push({ ...record, _op: 'create', createdAt: new Date().toISOString() });
  } else {
    const existing = list[index];
    list[index] = {
      ...existing,
      ...record,
      _op: existing._op === 'create' ? 'create' : 'update',
    };
  }

  if (flush) flushChanges();
}

function remove(entity, id) {
  const list = state[entity];
  const index = list.findIndex((r) => r.id === id);
  if (index === -1) return;

  if (!list[index]._synced) {
    // 還沒上傳過，直接從本機拿掉就好
    list.splice(index, 1);
  } else {
    list[index]._op = 'delete';
  }

  flushChanges();
}

/* ==========================================================================
   編輯既有紀錄
   ========================================================================== */

function editEntry(entity, id) {
  const record = state[entity].find((r) => r.id === id);
  if (!record) return;

  if (entity === 'trades') {
    const inst = instrumentById(record.instrumentId);
    openTradeSheet({
      category: inst ? inst.type : ETF,
      action: record.action === SELL ? SELL : BUY,
      record,
    });
  } else if (entity === 'dividends') {
    const inst = instrumentById(record.instrumentId);
    openDividendSheet({ category: inst ? inst.type : ETF, record });
  } else if (entity === 'cashflows') {
    openCashSheet({ category: record.account === '基金' ? FUND : ETF, record });
  }
}

function deleteEditing(entity) {
  if (!state.editing || state.editing.entity !== entity) return;
  remove(entity, state.editing.id);
  closeSheet();
  toast('已刪除');
}

/* ==========================================================================
   匯出
   ========================================================================== */

function downloadCsv(filename, rows) {
  const csv = rows.map((row) => row.map((cell) => {
    const text = String(cell === null || cell === undefined ? '' : cell);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(',')).join('\n');

  // BOM：Excel 沒有它會把中文顯示成亂碼
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportTrades() {
  const rows = [['日期', '類型', '標的', '動作', '型態', '數量', '單價', '金額', '手續費', '帳戶金額', '備註']];
  for (const t of live('trades').sort((a, b) => sortKey(a.date).localeCompare(sortKey(b.date)))) {
    const inst = instrumentById(t.instrumentId);
    rows.push([
      t.date === PRE ? PRE_LABEL : t.date,
      inst ? inst.type : '',
      instrumentName(t.instrumentId),
      t.action, t.style || '',
      t.quantity, t.price, t.amount, t.fee, t.cash, t.note || '',
    ]);
  }
  downloadCsv(`存錢筒-交易-${todayStr()}.csv`, rows);
}

function exportDividends() {
  const rows = [['發放日', '除息日', '類型', '標的', '每單位配息', '持有單位', '應發金額', '實領金額', '備註']];
  for (const d of live('dividends').sort((a, b) => sortKey(a.payDate).localeCompare(sortKey(b.payDate)))) {
    const inst = instrumentById(d.instrumentId);
    rows.push([
      d.payDate, d.exDate || '',
      inst ? inst.type : '',
      instrumentName(d.instrumentId),
      d.perUnit, d.units,
      Math.round((Number(d.perUnit) || 0) * (Number(d.units) || 0) * 100) / 100,
      d.received, d.note || '',
    ]);
  }
  downloadCsv(`存錢筒-配息-${todayStr()}.csv`, rows);
}

/* ==========================================================================
   主題
   ========================================================================== */

function applyTheme() {
  const dark = state.theme === 'dark'
    || (state.theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('theme-color').setAttribute('content', dark ? '#1d1a16' : '#fbf7ee');
}

/* ==========================================================================
   事件
   ========================================================================== */

function bindEvents() {
  // ---- 分頁 ----
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      state.page = tab.dataset.page;
      window.scrollTo(0, 0);
      render();
    });
  }

  $('btn-settings').addEventListener('click', () => {
    state.page = state.page === 'settings' ? 'record' : 'settings';
    window.scrollTo(0, 0);
    render();
  });

  $('sync-chip').addEventListener('click', () => {
    if (!state.apiUrl) {
      state.page = 'settings';
      render();
      return;
    }
    sync({ silent: false });
  });

  // ---- 記錄頁 ----
  for (const btn of document.querySelectorAll('.picker__btn')) {
    btn.addEventListener('click', () => {
      state.category = state.category === btn.dataset.category ? null : btn.dataset.category;
      state.showAllRecent = false;   // 換了類別就收回去，不然清單長度會忽然暴增
      renderRecord();
    });
  }

  $('btn-recent-more').addEventListener('click', () => {
    state.showAllRecent = !state.showAllRecent;
    renderRecent();
    if (!state.showAllRecent) $('recent-title').scrollIntoView({ block: 'nearest' });
  });

  for (const btn of document.querySelectorAll('.action')) {
    btn.addEventListener('click', () => {
      const category = state.category;
      if (!category) return;
      const action = btn.dataset.action;

      if (action === 'buy') openTradeSheet({ category, action: BUY });
      if (action === 'sell') openTradeSheet({ category, action: SELL });
      if (action === 'dividend') openDividendSheet({ category });
      if (action === 'cash') openCashSheet({ category });
    });
  }

  $('recent-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.entry');
    if (btn) editEntry(btn.dataset.entity, btn.dataset.id);
  });

  // ---- 報表頁 ----
  $('year-bar').addEventListener('click', (e) => {
    const btn = e.target.closest('.yearbar__btn');
    if (!btn) return;
    state.reportYear = Number(btn.dataset.year);
    renderReport();
  });

  // ---- 持股頁 ----
  $('holdings-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-price-id]');
    if (btn) openPriceSheet(btn.dataset.priceId);
  });

  $('btn-closed-toggle').addEventListener('click', () => {
    state.showClosed = !state.showClosed;
    renderHoldings();
  });

  // 點卡片展開／收合；展開後的「所有紀錄」才進明細面板
  for (const id of ['holdings-list', 'closed-list']) {
    $(id).addEventListener('click', (e) => {
      const link = e.target.closest('[data-detail-id]');
      if (link) return openDetailSheet(link.dataset.detailId);

      const toggle = e.target.closest('[data-toggle-id]');
      if (!toggle) return;
      const instrumentId = toggle.dataset.toggleId;
      if (state.expanded.has(instrumentId)) state.expanded.delete(instrumentId);
      else state.expanded.add(instrumentId);
      renderHoldings();
    });
  }

  // ---- 標的明細 ----
  $('detail-filter').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.detailFilter = chip.dataset.detail;
    renderDetail();
  });

  $('detail-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.entry');
    if (!btn) return;
    rememberDetailPosition();
    editEntry(btn.dataset.entity, btn.dataset.id);
  });

  $('btn-detail-edit').addEventListener('click', () => {
    const inst = instrumentById(state.detailId);
    if (!inst) return;
    rememberDetailPosition();
    openInstrumentSheet({ record: inst });
  });

  // ---- 顯示哪些資訊 ----
  $('btn-fields').addEventListener('click', openFieldsSheet);

  $('field-toggles').addEventListener('change', (e) => {
    const box = e.target.closest('input[data-field]');
    if (!box) return;
    const key = box.dataset.field;
    state.fields = box.checked
      ? [...state.fields, key]
      : state.fields.filter((k) => k !== key);
    saveFields();
  });

  $('btn-fields-reset').addEventListener('click', () => {
    state.fields = DEFAULT_FIELDS.slice();
    saveFields();
    renderFieldToggles();
    toast('已回到預設');
  });

  // ---- 底部面板共用 ----
  for (const sheet of document.querySelectorAll('.sheet')) bindSheetDrag(sheet);

  $('scrim').addEventListener('click', () => closeSheet());
  for (const btn of document.querySelectorAll('[data-close]')) {
    btn.addEventListener('click', () => closeSheet());
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openSheetId) closeSheet();
  });

  // 選項按鈕：點了就切換選中狀態
  for (const group of document.querySelectorAll('.chips')) {
    group.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip || !group.contains(chip)) return;
      for (const other of group.querySelectorAll('.chip')) other.classList.remove('is-active');
      chip.classList.add('is-active');

      if (group.id === 't-unit-chips') {
        state.draft.unit = chip.dataset.unit;
        recalcTrade();
      }
      if (group.id === 't-style-chips') {
        state.draft.style = chip.dataset.style;
        renderAmountQuick();   // 單筆和定期定額的常用金額不一樣
      }
      if (group.id === 'i-type-chips') syncCurrencyField();
      if (group.id === 'd-style-chips') {
        // 換了型態，持有單位要照那一邊重新帶入
        $('d-units').dataset.auto = '1';
        autofillUnits();
        updateDividendHints();
      }
      if (group.id === 'theme-chips') {
        state.theme = chip.dataset.themePref;
        localStorage.setItem(LS.theme, state.theme);
        applyTheme();
      }
    });
  }

  // ---- 交易表單 ----
  $('t-instrument').addEventListener('change', (e) => {
    if (e.target.value === '__new') {
      const category = state.draft.category;
      const action = state.draft.action;
      closeSheet(true);
      openInstrumentSheet({ type: category, returnTo: 'trade' });
      state.draft.action = action;
      return;
    }
    // 選了標的才知道是不是美元計價，欄位要跟著重排
    state.draft.usd = isUsd(instrumentById(e.target.value));
    layoutTradeFields(
      state.draft.category === ETF,
      state.draft.usd,
      state.draft.action === BUY
    );
    renderAmountQuick();   // 換了標的，常用金額跟著換
    recalcTrade();
  });

  $('t-rate').addEventListener('input', () => recalcTrade());

  $('t-amount-quick').addEventListener('click', (e) => {
    const btn = e.target.closest('.quick__btn');
    if (!btn) return;
    $('t-amount').value = fmtNum(Number(btn.dataset.amount), 2);
    recalcTrade('t-amount');
  });

  for (const id of ['t-qty', 't-price', 't-amount', 't-fee']) {
    $(id).addEventListener('input', () => recalcTrade(id === 't-price' || id === 't-fee' ? null : id));
  }
  $('t-cash').addEventListener('input', () => { $('t-cash').dataset.auto = '0'; });

  $('t-initial').addEventListener('change', syncTradeInitial);

  $('trade-form').addEventListener('submit', (e) => { e.preventDefault(); submitTrade(); });
  $('btn-trade-delete').addEventListener('click', () => deleteEditing('trades'));

  // ---- 配息表單 ----
  $('d-instrument').addEventListener('change', (e) => {
    if (e.target.value === '__new') {
      const category = state.draft.category;
      closeSheet(true);
      openInstrumentSheet({ type: category, returnTo: 'dividend' });
      return;
    }
    autofillUnits();
    updateDividendHints();
  });

  $('d-exdate').addEventListener('change', () => { autofillUnits(); updateDividendHints(); });
  for (const id of ['d-perunit', 'd-received']) {
    $(id).addEventListener('input', updateDividendHints);
  }
  $('d-units').addEventListener('input', () => {
    $('d-units').dataset.auto = '0';
    updateDividendHints();
  });

  $('dividend-form').addEventListener('submit', (e) => { e.preventDefault(); submitDividend(); });
  $('btn-dividend-delete').addEventListener('click', () => deleteEditing('dividends'));

  // ---- 資金表單 ----
  $('c-initial').addEventListener('change', () => syncInitialToggle('c-initial', 'c-date'));
  $('cash-form').addEventListener('submit', (e) => { e.preventDefault(); submitCash(); });
  $('btn-cash-delete').addEventListener('click', () => deleteEditing('cashflows'));

  // ---- 標的表單 ----
  $('instrument-form').addEventListener('submit', (e) => { e.preventDefault(); submitInstrument(); });
  $('btn-instrument-delete').addEventListener('click', () => {
    if (state.editing) deleteInstrument(state.editing.id);
  });

  // ---- 現價 ----
  $('price-form').addEventListener('submit', (e) => { e.preventDefault(); submitPrice(); });
  $('btn-fetch-price').addEventListener('click', fetchOnePrice);
  $('btn-refresh-prices').addEventListener('click', refreshEtfPrices);
  $('p-price').addEventListener('input', updatePricePreview);
  $('p-rate').addEventListener('input', updatePricePreview);

  // ---- 設定頁 ----
  $('btn-add-instrument').addEventListener('click', () => openInstrumentSheet({ type: ETF }));

  $('instrument-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-instrument-id]');
    if (!btn) return;
    const record = instrumentById(btn.dataset.instrumentId);
    if (record) openInstrumentSheet({ record });
  });

  $('btn-save-api').addEventListener('click', async () => {
    state.apiUrl = $('api-url').value.trim();
    state.secret = $('api-secret').value.trim();
    localStorage.setItem(LS.apiUrl, state.apiUrl);
    localStorage.setItem(LS.secret, state.secret);

    $('api-status').textContent = '測試中…';
    const ok = await sync({ silent: false });
    $('api-status').textContent = ok
      ? '連線成功，資料已同步'
      : (state.lastError ? `連線失敗：${state.lastError.message}` : '連線失敗');
  });

  $('btn-sync-now').addEventListener('click', () => sync({ silent: false }));
  $('btn-export-trades').addEventListener('click', exportTrades);
  $('btn-export-dividends').addEventListener('click', exportDividends);

  // ---- 系統 ----
  window.addEventListener('online', () => sync());
  window.addEventListener('offline', refreshSyncChip);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.theme === 'auto') applyTheme();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) sync();
  });
}

/* ==========================================================================
   啟動
   ========================================================================== */

function init() {
  loadLocal();
  applyTheme();
  bindEvents();
  render();
  refreshSyncChip();

  if (state.apiUrl) sync();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').then((reg) => {
        // 有新版時講一聲，不然使用者會以為修好的東西還是壞的
        reg.addEventListener('updatefound', () => {
          const incoming = reg.installing;
          if (!incoming) return;
          incoming.addEventListener('statechange', () => {
            if (incoming.state === 'installed' && navigator.serviceWorker.controller) {
              toast('有新版本，重新整理就會更新');
            }
          });
        });
      }).catch(() => { /* 沒註冊成功也不影響使用 */ });
    });
  }
}

init();
