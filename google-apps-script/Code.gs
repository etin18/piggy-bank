/**
 * 存錢筒 — ETF / 基金 投資記錄簿 後端 API（Google Apps Script）
 *
 * 部署方式：
 *   1. 開啟目標 Google 試算表 → 擴充功能 → Apps Script
 *   2. 把本檔內容整份貼上，存檔
 *   3. 部署 → 新增部署作業 → 類型選「網頁應用程式」
 *      - 執行身分：我
 *      - 具有存取權的使用者：任何人
 *   4. 複製產生的網址（結尾是 /exec），貼進 App 的「設定」
 *
 * 五個資料表都會在第一次呼叫時自動建立：
 *   「標的」  — 每個 ETF / 基金建一次
 *   「交易」  — 買進、賣出
 *   「配息」  — 每次配息入帳
 *   「資金」  — 帳戶存入、提領
 *   「現價」  — 手動更新的最新股價 / 淨值，一個標的一列
 *
 * ★★ 通關密語（重要，建議一定要設）★★
 *   把下面的 SECRET 改成你自己的一組密語（英數字，例如 'piggy2026kk'），
 *   再到 App 設定填入「同一組」密語。這樣就算有人拿到你的網址，
 *   沒有密語也讀不到、改不了你的資料 —— 這裡面是你的持股與金額。
 *
 *   ⚠️ 改好密語的這份程式是貼在「你自己的」Apps Script 編輯器裡，
 *      密語只存在 Google 端。請「不要」把含有真實密語的版本貼回 GitHub
 *      或任何公開的地方 —— 那等於把鑰匙公開。
 *
 *   （SECRET 留空字串代表不驗證，任何知道網址的人都能存取，僅供測試。）
 */

var SECRET = '';   // ← 改成你自己的通關密語，例如 'piggy2026kk'

/**
 * 後端版本。App 的設定頁會把它跟自己的版本並排顯示，
 * 用來確認這份程式有沒有真的重新部署上去 ——
 * 貼了新程式卻忘了「部署 → 管理部署作業 → 新版本」的話，跑的還是舊的。
 */
var API_VERSION = 'v12';

/* ==========================================================================
   資料表定義

   一張表一個設定物件，欄位順序＝試算表欄位順序。
   header 是試算表看到的中文標題，key 是 App 內部用的名稱。
   type 決定讀寫時怎麼轉換：
     text   一般文字
     number 數字（空白讀成 0）
     date   日期字串，整欄設純文字格式，避免 Sheets 把 2026-09-08 改成別的樣子
   ========================================================================== */

var SHEETS = {
  instruments: {
    sheetName: '標的',
    label: '標的',
    fields: [
      { key: 'id',        header: 'id',       type: 'text',   width: 250 },
      { key: 'code',      header: '代號',     type: 'text',   plain: true },
      { key: 'name',      header: '名稱',     type: 'text',   width: 200 },
      { key: 'type',      header: '類型',     type: 'text' },
      // 計價幣別。美元計價的基金，淨值是美元，算市值要再乘匯率
      { key: 'currency',  header: '計價幣別', type: 'text' },
      { key: 'frequency', header: '配息頻率', type: 'text' },
      { key: 'status',    header: '狀態',     type: 'text' },
      { key: 'note',      header: '備註',     type: 'text',   width: 200 },
      { key: 'createdAt', header: '建立時間', type: 'text' }
    ]
  },

  trades: {
    sheetName: '交易',
    label: '交易',
    fields: [
      { key: 'id',           header: 'id',       type: 'text',   width: 250 },
      { key: 'instrumentId', header: '標的id',   type: 'text',   width: 250 },
      { key: 'code',         header: '標的',     type: 'text',   plain: true },
      { key: 'date',         header: '日期',     type: 'date' },
      { key: 'action',       header: '動作',     type: 'text' },
      { key: 'style',        header: '型態',     type: 'text' },
      { key: 'quantity',     header: '數量',     type: 'number' },
      { key: 'price',        header: '單價',     type: 'number' },
      // 美元計價基金的申購／結匯匯率。台幣計價的填 1
      { key: 'rate',         header: '匯率',     type: 'number' },
      { key: 'amount',       header: '金額',     type: 'number' },
      { key: 'fee',          header: '手續費',   type: 'number' },
      { key: 'cash',         header: '帳戶金額', type: 'number' },
      { key: 'note',         header: '備註',     type: 'text',   width: 200 },
      { key: 'createdAt',    header: '建立時間', type: 'text' }
    ]
  },

  dividends: {
    sheetName: '配息',
    label: '配息',
    fields: [
      { key: 'id',           header: 'id',         type: 'text',   width: 250 },
      { key: 'instrumentId', header: '標的id',     type: 'text',   width: 250 },
      { key: 'code',         header: '標的',       type: 'text',   plain: true },
      // 基金的單筆與定期定額在銀行是兩筆各自獨立的投資明細，配息也分開發，
      // 所以配息要記是哪一種。ETF 不分，留空
      { key: 'style',        header: '型態',       type: 'text' },
      { key: 'exDate',       header: '除息日',     type: 'date' },
      { key: 'payDate',      header: '發放日',     type: 'date' },
      { key: 'perUnit',      header: '每單位配息', type: 'number' },
      { key: 'units',        header: '持有單位',   type: 'number' },
      { key: 'received',     header: '實領金額',   type: 'number' },
      { key: 'note',         header: '備註',       type: 'text',   width: 200 },
      { key: 'createdAt',    header: '建立時間',   type: 'text' }
    ]
  },

  cashflows: {
    sheetName: '資金',
    label: '資金',
    fields: [
      { key: 'id',        header: 'id',       type: 'text',   width: 250 },
      { key: 'date',      header: '日期',     type: 'date' },
      { key: 'account',   header: '帳戶',     type: 'text' },
      { key: 'action',    header: '動作',     type: 'text' },
      { key: 'amount',    header: '金額',     type: 'number' },
      { key: 'note',      header: '備註',     type: 'text',   width: 200 },
      { key: 'createdAt', header: '建立時間', type: 'text' }
    ]
  },

  prices: {
    sheetName: '現價',
    label: '現價',
    fields: [
      { key: 'id',        header: '標的id',   type: 'text',   width: 250 },
      { key: 'code',      header: '標的',     type: 'text',   plain: true },
      { key: 'price',     header: '價格',     type: 'number' },
      // 美元計價基金的參考匯率。台幣計價的填 1
      { key: 'rate',      header: '匯率',     type: 'number' },
      { key: 'updatedAt', header: '更新時間', type: 'text' }
    ]
  }
};

/* ---------- 進入點 ---------- */

/**
 * 用瀏覽器直接開這個網址時的回應。
 * 不從這裡讀資料 —— 讀寫一律走 POST 並驗證密語，避免有人用 GET 繞過。
 */
function doGet(e) {
  return respond({ ok: true, service: '存錢筒 API', message: '這是 API 端點，請從 App 使用。' });
}

function doPost(e) {
  var payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (err) {
    return respond({ ok: false, error: '無法解析請求內容' });
  }
  return respond(route(payload));
}

/**
 * 所有操作都在 script lock 內執行，避免同時送出時互相蓋掉。
 */
function route(payload) {
  var action = payload.action || 'list';

  // 通關密語驗證（SECRET 留空則略過）。放最前面，錯的密語連鎖都不用搶。
  var expected = String(SECRET || '').trim();
  if (expected && String(payload.secret || '').trim() !== expected) {
    return { ok: false, error: '通關密語錯誤，請到設定確認', authError: true };
  }

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return { ok: false, error: '系統忙碌中，請稍後再試' };
  }

  try {
    switch (action) {
      case 'list':
        return {
          ok: true,
          instruments: listRows('instruments'),
          trades: listRows('trades'),
          dividends: listRows('dividends'),
          cashflows: listRows('cashflows'),
          prices: listRows('prices')
        };
      case 'save':
        return { ok: true, entity: payload.entity, record: saveRow(payload.entity, payload.record) };
      case 'remove':
        return { ok: true, entity: payload.entity, id: removeRow(payload.entity, payload.id) };
      case 'quotes':
        return { ok: true, quotes: fetchQuotes(payload.codes || []) };
      default:
        return { ok: false, error: '未知的操作：' + action };
    }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  } finally {
    lock.releaseLock();
  }
}

function respond(obj) {
  obj.apiVersion = API_VERSION;   // 每個回應都帶著，App 才知道後端是哪一版
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ==========================================================================
   通用 CRUD

   五張表結構不同但操作一樣，所以共用同一組函式，
   差異全部寫在上面的 SHEETS 設定裡。
   ========================================================================== */

function getConfig(entity) {
  var config = SHEETS[entity];
  if (!config) throw new Error('未知的資料表：' + entity);
  return config;
}

function getSheet(entity) {
  var config = getConfig(entity);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(config.sheetName);

  if (!sheet) {
    sheet = ss.insertSheet(config.sheetName);
    var headers = config.fields.map(function (f) { return f.header; });
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');

    for (var i = 0; i < config.fields.length; i++) {
      if (config.fields[i].width) sheet.setColumnWidth(i + 1, config.fields[i].width);
    }
    ensureFormats(sheet, config);
  } else {
    ensureColumns(sheet, config);
    ensureFormats(sheet, config);
  }
  return sheet;
}

/**
 * 日期欄和代號欄都要設成純文字：
 *   日期 —— 否則 Sheets 會把 2026-09-08 轉成本地日期格式，讀回來就不是原本的樣子
 *   代號 —— 否則 0809 會被當成數字存成 809，前面的 0 就沒了（0056 也一樣）
 *
 * 格式要先設好再寫值。值一旦被存成數字，之後再改格式也救不回前面的 0。
 */
function ensureFormats(sheet, config) {
  var rows = Math.max(1, sheet.getMaxRows() - 1);
  for (var i = 0; i < config.fields.length; i++) {
    var field = config.fields[i];
    if (field.type === 'date' || field.plain) {
      sheet.getRange(2, i + 1, rows, 1).setNumberFormat('@');
    }
  }
}

/**
 * 舊版建立的資料表會少掉後來才加的欄位（例如「計價幣別」「匯率」）。
 * 這裡在正確位置補上，既有資料會跟著右移。
 *
 * 少了這一步，新版程式會照新的欄位順序寫入，
 * 舊表就變成「表頭寫配息頻率、底下卻是計價幣別」的錯位狀態。
 */
function ensureColumns(sheet, config) {
  var lastCol = sheet.getLastColumn();
  if (!lastCol) return;

  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  for (var i = 0; i < headers.length; i++) {
    headers[i] = String(headers[i] === null || headers[i] === undefined ? '' : headers[i]).trim();
  }

  for (var j = 0; j < config.fields.length; j++) {
    var field = config.fields[j];
    if (headers[j] === field.header) continue;            // 位置正確
    if (headers.indexOf(field.header) !== -1) continue;   // 已存在只是順序不同，不亂動

    if (j >= headers.length) {
      // 補在最後面
      if (j + 1 > sheet.getMaxColumns()) sheet.insertColumnAfter(sheet.getMaxColumns());
      headers.push(field.header);
    } else {
      sheet.insertColumnBefore(j + 1);
      headers.splice(j, 0, field.header);
    }

    sheet.getRange(1, j + 1).setValue(field.header).setFontWeight('bold');
    if (field.width) sheet.setColumnWidth(j + 1, field.width);
  }
}

function listRows(entity) {
  var config = getConfig(entity);
  var sheet = getSheet(entity);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var values = sheet.getRange(2, 1, lastRow - 1, config.fields.length).getValues();
  var rows = [];

  for (var i = 0; i < values.length; i++) {
    var raw = values[i];
    if (!raw[0]) continue; // 略過空列
    var record = {};
    for (var j = 0; j < config.fields.length; j++) {
      record[config.fields[j].key] = readCell(raw[j], config.fields[j].type);
    }
    rows.push(record);
  }
  return rows;
}

/**
 * 有 id 且找得到就覆寫該列，否則新增一列。
 * App 端本來就會自己產 id，所以同一筆重送不會變成兩列。
 */
function saveRow(entity, record) {
  var config = getConfig(entity);
  if (!record) throw new Error('缺少' + config.label + '資料');

  validate(entity, record);

  var sheet = getSheet(entity);
  var id = String(record.id || '').trim() || Utilities.getUuid();
  var rowIndex = findRowById(sheet, id);

  var out = {};
  for (var i = 0; i < config.fields.length; i++) {
    var field = config.fields[i];
    out[field.key] = writeCell(record[field.key], field.type);
  }
  out.id = id;

  if (rowIndex === -1) {
    out.createdAt = new Date().toISOString();
  } else {
    // 保留原本的建立時間，App 送上來的可能是空的
    var existing = sheet.getRange(rowIndex, 1, 1, config.fields.length).getValues()[0];
    var createdIndex = fieldIndex(config, 'createdAt');
    if (createdIndex !== -1) {
      out.createdAt = normalizeTimestamp(existing[createdIndex]) || new Date().toISOString();
    }
  }
  if (fieldIndex(config, 'updatedAt') !== -1) out.updatedAt = new Date().toISOString();

  var rowValues = config.fields.map(function (f) { return out[f.key]; });

  if (rowIndex === -1) {
    sheet.appendRow(rowValues);
    rowIndex = sheet.getLastRow();
  } else {
    sheet.getRange(rowIndex, 1, 1, config.fields.length).setValues([rowValues]);
  }

  return out;
}

function removeRow(entity, id) {
  var config = getConfig(entity);
  if (!id) throw new Error('缺少要刪除的' + config.label + ' id');

  var sheet = getSheet(entity);
  var rowIndex = findRowById(sheet, id);
  if (rowIndex === -1) throw new Error('找不到這筆' + config.label + '，可能已被刪除');

  sheet.deleteRow(rowIndex);
  return id;
}

function fieldIndex(config, key) {
  for (var i = 0; i < config.fields.length; i++) {
    if (config.fields[i].key === key) return i;
  }
  return -1;
}

function findRowById(sheet, id) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;

  var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2; // +2：跳過表頭且轉 1-based
  }
  return -1;
}

/* ==========================================================================
   欄位轉換
   ========================================================================== */

function readCell(value, type) {
  if (type === 'number') {
    if (value === '' || value === null || value === undefined) return 0;
    var n = Number(value);
    return isNaN(n) ? 0 : n;
  }
  if (type === 'date') return normalizeDate(value);
  if (value instanceof Date) return normalizeTimestamp(value);
  return String(value === null || value === undefined ? '' : value);
}

function writeCell(value, type) {
  if (type === 'number') {
    if (value === '' || value === null || value === undefined) return 0;
    var n = Number(value);
    return isNaN(n) ? 0 : n;
  }
  if (type === 'date') return normalizeDate(value);
  return String(value === null || value === undefined ? '' : value).trim();
}

/**
 * 試算表可能把日期回傳為 Date 物件或字串，統一輸出 YYYY-MM-DD。
 * 特殊值 PRE2025（＝「2025 之前」的期初）原樣保留。
 */
function normalizeDate(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  var text = String(value === null || value === undefined ? '' : value).trim();
  if (text === 'PRE2025') return text;

  var match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (match) return match[1] + '-' + pad2(match[2]) + '-' + pad2(match[3]);
  return text;
}

function normalizeTimestamp(value) {
  if (value instanceof Date) return value.toISOString();
  return String(value === null || value === undefined ? '' : value);
}

function pad2(n) {
  n = String(n);
  return n.length < 2 ? '0' + n : n;
}

/* ==========================================================================
   台股報價

   瀏覽器不能直接抓證交所（跨網域會被擋），但 Apps Script 可以，
   所以「更新現價」按鈕是繞到這裡代抓的。

   三個來源依序試，先拿到就先用：
     1. 證交所 MIS —— 盤中的即時成交價（延遲約 20 秒）
     2. 證交所每日收盤 OpenAPI —— 上市股票的當日收盤
     3. 櫃買中心每日收盤 OpenAPI —— 上櫃的（少數債券 ETF 在這裡）

   盤前、盤後與假日 MIS 的成交價欄位是「-」，這時退而用前一筆成交價或昨收，
   也就是最近一個交易日的收盤價 —— 那正是這種時候該看的數字。

   ⚠️ 這個功能會讓 Apps Script 需要「連線至外部服務」的權限。
      如果你之前部署過舊版，貼上新版後要重新部署一次並同意授權。
   ========================================================================== */

function fetchQuotes(codes) {
  var wanted = [];
  for (var i = 0; i < codes.length; i++) {
    var code = String(codes[i] || '').trim().toUpperCase();
    if (code && wanted.indexOf(code) === -1) wanted.push(code);
  }
  if (!wanted.length) return {};

  var result = {};
  fetchFromMis(wanted, result);
  fetchFromDailyApi(missingOf(wanted, result), result);

  return result;
}

function missingOf(wanted, result) {
  var missing = [];
  for (var i = 0; i < wanted.length; i++) {
    if (!result[wanted[i]]) missing.push(wanted[i]);
  }
  return missing;
}

/** 第一個能轉成正數的值，用來在 z（成交）、y（昨收）、pz（前一筆）之間挑 */
function firstPrice(values) {
  for (var i = 0; i < values.length; i++) {
    var n = Number(String(values[i] === null || values[i] === undefined ? '' : values[i]).replace(/,/g, ''));
    if (isFinite(n) && n > 0) return n;
  }
  return 0;
}

function fetchFromMis(codes, result) {
  // 一次問太多會被截斷，分批送。上市上櫃都問，不存在的那個會回空物件
  for (var start = 0; start < codes.length; start += 20) {
    var batch = codes.slice(start, start + 20);
    var channels = [];
    for (var i = 0; i < batch.length; i++) {
      channels.push('tse_' + batch[i] + '.tw');
      channels.push('otc_' + batch[i] + '.tw');
    }

    var url = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?json=1&delay=0&ex_ch='
      + channels.join('|');

    try {
      var res = UrlFetchApp.fetch(url, {
        muteHttpExceptions: true,
        followRedirects: true,
        headers: { 'Referer': 'https://mis.twse.com.tw/stock/fibest.jsp' }
      });
      if (res.getResponseCode() !== 200) continue;

      var data = JSON.parse(res.getContentText());
      var rows = data.msgArray || [];

      for (var j = 0; j < rows.length; j++) {
        var row = rows[j];
        var code = String(row.c || '').trim().toUpperCase();
        if (!code || result[code]) continue;

        // 順序不能換：開盤前 8:30～9:00 是試搓，pz 會是模擬撮合價而不是真實成交價，
        // 拿它當現價會跟官方收盤差好幾分。沒有成交價時昨收才是對的數字。
        var price = firstPrice([row.z, row.y, row.pz]);
        if (!price) continue;

        var live = firstPrice([row.z]) > 0;
        result[code] = {
          price: price,
          name: String(row.n || ''),
          live: live,          // 今天真的有成交，否則拿到的是上一個交易日的收盤
          time: String(row.t || ''),
          source: live ? '最新成交' : '前一交易日收盤'
        };
      }
    } catch (err) {
      // 這個來源掛了就換下一個，不要整個功能陪葬
    }
  }
}

function fetchFromDailyApi(codes, result) {
  if (!codes.length) return;

  var sources = [
    {
      url: 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
      codeKey: 'Code', priceKey: 'ClosingPrice', nameKey: 'Name', label: '上市收盤'
    },
    {
      url: 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes',
      codeKey: 'SecuritiesCompanyCode', priceKey: 'Close', nameKey: 'CompanyName', label: '上櫃收盤'
    }
  ];

  for (var s = 0; s < sources.length; s++) {
    if (!missingOf(codes, result).length) return;
    var source = sources[s];

    try {
      var res = UrlFetchApp.fetch(source.url, { muteHttpExceptions: true, followRedirects: true });
      if (res.getResponseCode() !== 200) continue;

      var rows = JSON.parse(res.getContentText());
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var code = String(row[source.codeKey] || '').trim().toUpperCase();
        if (!code || result[code] || codes.indexOf(code) === -1) continue;

        var price = firstPrice([row[source.priceKey]]);
        if (!price) continue;

        result[code] = {
          price: price,
          name: String(row[source.nameKey] || ''),
          live: false,
          time: '',
          source: source.label
        };
      }
    } catch (err) {
      // 同上，換下一個來源
    }
  }
}

/* ==========================================================================
   驗證

   只擋會讓報表算錯的欄位。金額為 0 是允許的（有些配息真的很少、
   有些交易手續費為 0），所以只檢查「有沒有填」而不是「大不大於零」。
   ========================================================================== */

function validate(entity, record) {
  switch (entity) {
    case 'instruments':
      if (!String(record.name || '').trim()) throw new Error('請填寫標的名稱');
      if (!String(record.type || '').trim()) throw new Error('缺少標的類型');
      break;

    case 'trades':
      if (!String(record.instrumentId || '').trim()) throw new Error('請選擇標的');
      if (!String(record.date || '').trim()) throw new Error('缺少交易日期');
      if (!String(record.action || '').trim()) throw new Error('缺少買進或賣出');
      if (!Number(record.quantity)) throw new Error('請填寫數量');
      break;

    case 'dividends':
      if (!String(record.instrumentId || '').trim()) throw new Error('請選擇標的');
      if (!String(record.payDate || '').trim()) throw new Error('缺少發放日');
      break;

    case 'cashflows':
      if (!String(record.date || '').trim()) throw new Error('缺少日期');
      if (!String(record.account || '').trim()) throw new Error('缺少帳戶');
      if (!Number(record.amount)) throw new Error('請填寫金額');
      break;

    case 'prices':
      if (!String(record.id || '').trim()) throw new Error('缺少標的');
      break;
  }
}
