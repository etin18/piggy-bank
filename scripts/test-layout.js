/**
 * 版面小細節檢查：每個主題 × 每一頁 × 幾種手機寬度，找「東西跑出去」這類問題。
 * 執行：PW_CORE=<playwright-core 路徑> node scripts/test-layout.js
 *
 * 這些都是實際在手機上被看到才發現的：
 *   - 設定頁的外觀按鈕加到六顆，一行放不下，整頁被撐寬可以左右滑
 *   - 明細頁的列表 grid 被最長那一列撐開，每一筆都比卡片寬
 *   - 紀錄的說明文字是 <span>，吃不到 ellipsis，整行穿到金額底下
 *   - 粉色主題的買賣圖示被藏起來的字擠到上半部，看起來偏高
 * 數字對不對 screenshot.js 顧得到，這種「看起來怪怪的」只能另外掃。
 *
 * 資料故意灌得很長（長名稱、長說明、很多檔），平常的資料不會把版面逼到極限。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require(process.env.PW_CORE);

const BASE = 'http://localhost:8789';

function findChromium() {
  if (process.env.PW_CHROME) return process.env.PW_CHROME;
  const base = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  const dirs = fs.readdirSync(base)
    .filter((d) => d.startsWith('chromium'))
    .sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop()));
  for (const d of dirs) {
    for (const rel of ['chrome-headless-shell-mac-arm64/chrome-headless-shell',
      'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const full = path.join(base, d, rel);
      if (fs.existsSync(full)) return full;
    }
  }
}

/* ---------- 故意很長的資料 ---------- */

// 全部是虛構的標的和數字 —— repo 是公開的，測試資料不能照抄使用者的持股或成交價
const LONG = '虛構全球投資系列－長名字測試基金美元累積型超長名稱';
const instruments = [
  { id: 'e1', code: 'T001A', name: '測試高股息動能主動型', type: 'ETF', currency: 'TWD', frequency: '季配', status: '持有中' },
  { id: 'e2', code: 'T0002', name: '測試市值型指數五十', type: 'ETF', currency: 'TWD', frequency: '半年配', status: '持有中' },
  { id: 'e3', code: 'T003A', name: '測試未來科技主動型', type: 'ETF', currency: 'TWD', frequency: '不配息', status: '持有中' },
  { id: 'f1', code: 'X901', name: LONG, type: '基金', currency: 'USD', frequency: '月配', status: '持有中' },
  { id: 'f2', code: 'X902', name: '虛構收益成長基金－穩定月收類股（美元）', type: '基金', currency: 'TWD', frequency: '月配', status: '持有中' },
];
const trades = [];
const dividends = [];
let n = 0;
for (const inst of instruments) {
  for (const [date, style] of [['2026-01-05', '小額'], ['2026-03-05', '單筆'], ['2026-06-05', '小額']]) {
    const qty = inst.type === 'ETF' ? 1234 : 123.4567;
    const price = inst.type === 'ETF' ? 88.88 : 12.3456;
    trades.push({
      id: 't' + (++n), instrumentId: inst.id, date, action: '買進', style,
      quantity: qty, price, rate: 1, amount: Math.round(qty * price), fee: 25,
      cash: Math.round(qty * price) + 25, note: '',
    });
  }
  dividends.push({
    id: 'd' + (++n), instrumentId: inst.id, exDate: '2026-04-18', payDate: '2026-05-10',
    style: inst.type === '基金' ? '小額' : '', perUnit: 0.123456, units: 1234, received: 1520, note: '',
  });
}
const cashflows = [
  { id: 'c1', date: '2026-01-02', account: '券商', action: '存入', amount: 1234567, note: '年初轉入備用金，之後定期定額用' },
  { id: 'c2', date: '2026-02-02', account: '基金', action: '交割折讓', amount: 22, note: '' },
];
const prices = instruments.map((i) => ({ id: 'p' + i.id, instrumentId: i.id, price: 110.5, rate: 1, updatedAt: '2026-09-15T08:00:00Z' }));

const DATA = { instruments, trades, dividends, cashflows, prices };

// ETF 配息公告（虛構），讓報表頁的配息行事曆也被掃到：過去、已除息未發放、待公告都有
const shift = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const ETF_DIV = {
  fetchedAt: new Date().toISOString(),
  byCode: Object.fromEntries(instruments.filter((i) => i.type === 'ETF').map((i) => [i.code, [
    { exDate: shift(-50), recordDate: shift(-44), payDate: shift(-30), perUnit: 0.123 },
    { exDate: shift(-10), recordDate: shift(-4), payDate: shift(12), perUnit: 1.75 },
    { exDate: shift(20), recordDate: shift(26), payDate: shift(45), perUnit: null },
  ]])),
};

const THEMES = ['light', 'dark', 'haze', 'forest', 'pink'];
const PAGES = ['record', 'report', 'holdings', 'ledger', 'settings'];
// 360 是多數 Android、390 是多數 iPhone；320 是很舊的小手機，只提醒不算失敗
const WIDTHS = [360, 390];
const SMALL = 320;

(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() });
  const problems = [];
  const warnings = [];
  const errors = [];

  for (const width of [...WIDTHS, SMALL]) {
    // 擋掉 Service Worker：它接手時會自動重新整理一次，剛好打斷灌資料
    const context = await browser.newContext({ viewport: { width, height: 800 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(BASE);
    await page.evaluate(({ etfDiv, ...data }) => {
      localStorage.clear();
      for (const [k, list] of Object.entries(data)) {
        localStorage.setItem('pb.' + k, JSON.stringify(list.map((r) => ({ ...r, _synced: true }))));
      }
      localStorage.setItem('pb.etfDividends', JSON.stringify(etfDiv));
    }, { ...DATA, etfDiv: ETF_DIV });
    await page.reload();
    await page.waitForTimeout(600);

    for (const theme of THEMES) {
      await page.evaluate((t) => { state.theme = t; applyTheme(); }, theme);

      for (const name of PAGES) {
        for (const split of name === 'report' || name === 'ledger' ? [false, true] : [false]) {
          await page.evaluate(({ name, split }) => {
            state.page = name;
            state.reportSplit = split;
            state.ledger.split = split;
            state.showAllRecent = true;
            document.querySelectorAll('.page').forEach((s) => { s.hidden = s.id !== 'page-' + name; });
            render();
            window.scrollTo(0, 0);
          }, { name, split });
          await page.waitForTimeout(100);

          const found = await page.evaluate(() => {
            const W = document.documentElement.clientWidth;
            const out = [];

            // 1. 整頁可以左右滑
            if (document.documentElement.scrollWidth > W + 1) {
              out.push(`整頁被撐寬到 ${document.documentElement.scrollWidth}px`);
            }

            // 2. 有東西超出畫面右邊。被外層「…」截掉藏起來的不算
            //    （例如持股名稱太長時，後面的代號和標籤會被截掉，那是設計好的）
            const clipped = (el) => {
              for (let a = el.parentElement; a && a.id !== 'main'; a = a.parentElement) {
                if (getComputedStyle(a).overflowX !== 'visible' && a.getBoundingClientRect().right <= W + 1) return true;
              }
              return false;
            };
            for (const el of document.querySelectorAll('#main *')) {
              if (!el.offsetParent) continue;
              const r = el.getBoundingClientRect();
              if (r.width && r.right > W + 1 && !clipped(el)) {
                out.push(`${el.id ? '#' + el.id : '.' + String(el.className).split(' ')[0]} 超出右邊（到 ${Math.round(r.right)}px）`);
              }
            }

            // 3. 列表裡的說明文字不能穿到金額底下
            for (const entry of document.querySelectorAll('.entry')) {
              if (!entry.offsetParent) continue;
              const amount = entry.querySelector('.entry__amount');
              if (!amount) continue;
              const a = amount.getBoundingClientRect();
              for (const t of entry.querySelectorAll('.entry__name, .entry__meta')) {
                if (t.getBoundingClientRect().right > a.left + 1) {
                  out.push(`「${entry.querySelector('.entry__name').textContent.trim()}」的文字疊到金額上`);
                }
              }
            }

            // 4. 標籤裡的圖示要在正中央（粉色主題換成圖示時出過事）
            for (const tag of document.querySelectorAll('.entry__tag, .action__mark')) {
              if (!tag.offsetParent) continue;
              const before = getComputedStyle(tag, '::before');
              if (before.content === 'none' || before.content === 'normal') continue;
              if (before.position !== 'absolute') out.push(`${tag.className} 的圖示沒有置中`);
            }

            return [...new Set(out)].slice(0, 5);
          });

          if (found.length) {
            const where = `${width}px ${theme}／${name}${split ? '（分開看）' : ''}`;
            (width === SMALL ? warnings : problems).push(`${where}：${found.join('；')}`);
          }
        }
      }
    }
    await context.close();
  }

  await browser.close();

  const total = (WIDTHS.length + 1) * THEMES.length * (PAGES.length + 2);
  console.log(`\n掃了 ${total} 個畫面（${[...WIDTHS, SMALL].join('／')}px × ${THEMES.length} 個主題 × 每一頁）\n`);
  if (warnings.length) {
    console.log('⚠ 320px 小手機（只提醒）');
    for (const w of warnings) console.log('  ' + w);
    console.log('');
  }
  if (errors.length) console.log('❌ JS 錯誤：\n  ' + [...new Set(errors)].join('\n  '));
  if (problems.length) {
    console.log('❌ 版面問題');
    for (const p of problems) console.log('  ' + p);
    process.exit(1);
  }
  if (!errors.length) console.log('✅ 沒有東西跑出去、沒有文字疊在一起、圖示都置中');
})();
