/**
 * 報表頁的區塊編輯：顯示／隱藏、拖曳排序、記住、恢復預設。
 * 執行：PW_CORE=<playwright-core 路徑> node scripts/test-report-blocks.js
 *
 * 拖曳用兩種方式都試：滑鼠（pointer events），和 CDP 送的真觸控事件 ——
 * 面板本身有「往下拉關閉」的手勢，手指往下拖一列時不能把整個面板拉掉。
 * 資料全部虛構。
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

const SEED = {
  instruments: [
    { id: 'a', code: 'T001A', name: '測試高息', type: 'ETF', currency: 'TWD', frequency: '季配', status: '持有中' },
    { id: 'f', code: 'X901', name: '測試基金', type: '基金', currency: 'TWD', frequency: '月配', status: '持有中' },
  ],
  trades: [
    { id: 't1', instrumentId: 'a', date: '2026-01-05', action: '買進', style: '單筆', quantity: 1000, price: 20, rate: 1, amount: 20000, fee: 28, cash: 20028, note: '' },
    { id: 't2', instrumentId: 'f', date: '2026-01-05', action: '買進', style: '小額', quantity: 100, price: 10, rate: 1, amount: 1000, fee: 0, cash: 1000, note: '' },
  ],
  dividends: [], cashflows: [], prices: [],
};

const DEFAULT = ['div', 'chart', 'divcal', 'balance', 'pl', 'pie'];

const problems = [];
let pass = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); } else {
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
    problems.push(`${name}${detail ? '：' + detail : ''}`);
  }
}

(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const load = async (extra = {}) => {
    await page.goto(BASE);
    await page.evaluate(({ seed, extra }) => {
      localStorage.clear();
      for (const [k, list] of Object.entries(seed)) {
        localStorage.setItem('pb.' + k, JSON.stringify(list.map((r) => ({ ...r, _synced: true }))));
      }
      for (const [k, v] of Object.entries(extra)) localStorage.setItem(k, v);
    }, { seed: SEED, extra });
    await page.reload();
    await page.waitForTimeout(500);
    await page.evaluate(() => document.querySelector('.tab[data-page="report"]').click());
    await page.waitForTimeout(200);
  };
  const pageOrder = () => page.evaluate(() => [...document.querySelectorAll('#page-report [data-block]')].map((el) => el.dataset.block));
  const listOrder = () => page.evaluate(() => [...document.querySelectorAll('#block-list .block-row')].map((el) => el.dataset.key));
  const shown = (key) => page.evaluate((k) => getComputedStyle(document.querySelector(`[data-block="${k}"]`)).display !== 'none', key);
  const openEditor = async () => {
    await page.locator('#btn-report-edit').click();
    await page.waitForTimeout(400);
  };

  console.log('\n── 預設 ──');
  await load();
  check('區塊照預設順序排', JSON.stringify(await pageOrder()) === JSON.stringify(DEFAULT), (await pageOrder()).join(' '));
  await openEditor();
  check('面板列出全部區塊', (await listOrder()).length === DEFAULT.length);

  console.log('\n── 隱藏 ──');
  await page.locator('#block-list [data-block-toggle="balance"]').evaluate((el) => el.click());
  await page.waitForTimeout(150);
  check('關掉「帳戶餘額」就看不到', !(await shown('balance')));

  console.log('\n── 滑鼠拖曳 ──');
  const handle = (key) => page.locator(`#block-list .block-row[data-key="${key}"] [data-drag-handle]`);
  const box = await handle('pie').boundingBox();
  const top = await handle('div').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let y = box.y + box.height / 2; y > top.y - 10; y -= 8) await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.up();
  await page.waitForTimeout(150);
  check('把「投入佔比」拖到最上面', (await listOrder())[0] === 'pie', (await listOrder()).join(' '));
  check('報表頁跟著變', (await pageOrder())[0] === 'pie', (await pageOrder()).join(' '));

  console.log('\n── 手指拖曳（CDP 真觸控）──');
  const cdp = await context.newCDPSession(page);
  const t = await handle('div').boundingBox();
  const x = t.x + t.width / 2;
  let y = t.y + t.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 0; i < 16; i++) {
    y += 8;   // 往下拖 —— 正是面板「往下拉關閉」的方向
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(500);
  check('往下拖一列，面板沒有被拉掉', await page.locator('#blocks-sheet').isVisible());
  const afterTouch = await listOrder();
  check('「配息」往下移了', afterTouch.indexOf('div') > 1, afterTouch.join(' '));

  console.log('\n── 鍵盤 ──');
  await handle('pl').focus();
  const before = (await listOrder()).indexOf('pl');
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(100);
  check('上鍵往上移一格', (await listOrder()).indexOf('pl') === before - 1, (await listOrder()).join(' '));

  console.log('\n── 記住 ──');
  const saved = await listOrder();
  await page.reload();
  await page.waitForTimeout(500);
  await page.evaluate(() => document.querySelector('.tab[data-page="report"]').click());
  await page.waitForTimeout(200);
  check('重新打開順序還在', JSON.stringify(await pageOrder()) === JSON.stringify(saved), (await pageOrder()).join(' '));
  check('關掉的還是關著', !(await shown('balance')));

  console.log('\n── 不能全部關掉 ──');
  await openEditor();
  for (const key of DEFAULT) {
    await page.locator(`#block-list [data-block-toggle="${key}"]`).evaluate((el) => { if (el.checked) el.click(); });
    await page.waitForTimeout(60);
  }
  const visible = await page.evaluate(() => state.reportBlocks.hidden.length);
  check('最後一個關不掉', visible === DEFAULT.length - 1, `藏了 ${visible} 個`);

  console.log('\n── 恢復預設 ──');
  await page.locator('#btn-blocks-reset').click();
  await page.waitForTimeout(150);
  check('順序回到預設', JSON.stringify(await pageOrder()) === JSON.stringify(DEFAULT));
  check('全部顯示', (await page.evaluate(() => state.reportBlocks.hidden.length)) === 0);
  await page.evaluate(() => closeSheet(true));

  console.log('\n── 以後新增的區塊 ──');
  // 假裝使用者是在「投入佔比」還不存在的時候排過順序
  await load({ 'pb.reportBlocks': JSON.stringify({ order: ['pl', 'div', 'chart', 'divcal', 'balance'], hidden: ['chart'] }) });
  const o = await pageOrder();
  check('排過的順序照舊', o.slice(0, 5).join(' ') === 'pl div chart divcal balance', o.join(' '));
  check('新區塊接在最後面', o[5] === 'pie', o.join(' '));
  check('新區塊預設顯示', await shown('pie'));
  check('舊設定裡不認得的區塊會被丟掉', (await page.evaluate(() => {
    localStorage.setItem('pb.reportBlocks', JSON.stringify({ order: ['ghost', 'pie'], hidden: ['ghost'] }));
    return normalizeReportBlocks(JSON.parse(localStorage.getItem('pb.reportBlocks'))).order.includes('ghost');
  })) === false);

  check('沒有 JS 錯誤', !errors.length, errors.join('；'));
  await browser.close();

  console.log('\n──────────────────────────────────────────────');
  if (problems.length) {
    console.log(`❌ ${problems.length} 項沒過\n  ` + problems.join('\n  '));
    process.exit(1);
  }
  console.log(`✅ ${pass} 項通過`);
})();
