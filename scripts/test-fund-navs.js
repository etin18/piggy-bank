/**
 * 基金淨值自動更新：「更新現價」一次更新 ETF 和填了淨值代碼的基金。
 * 執行：PW_CORE=<playwright-core 路徑> node scripts/test-fund-navs.js
 *
 * 後端用 page.route 假裝；標的、代碼、淨值全部虛構（repo 是公開的）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require(process.env.PW_CORE);

const BASE = 'http://localhost:8789';
const API = 'https://mock.local/exec';

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

/*
 * F1：美元基金，有淨值代碼 → 淨值 × 當天匯率
 * F2：台幣基金，有淨值代碼 → 匯率 1
 * F3：美元基金，沒填淨值代碼 → 不動，照舊手動
 * F4：標成美元，但鉅亨網回的是台幣 → 不寫（免得把台幣淨值當美元乘匯率）
 */
const SEED = {
  instruments: [
    { id: 'e', code: 'T001A', name: '測試高息', type: 'ETF', currency: 'TWD', frequency: '季配', status: '持有中' },
    { id: 'f1', code: 'X901', name: '測試美元基金', type: '基金', currency: 'USD', frequency: '月配', status: '持有中', navId: 'Z1,001', note: '這是備註' },
    { id: 'f2', code: 'X902', name: '測試台幣基金', type: '基金', currency: 'TWD', frequency: '不配息', status: '持有中', navId: 'Z2abc' },
    { id: 'f3', code: 'X903', name: '測試沒代碼', type: '基金', currency: 'USD', frequency: '月配', status: '持有中' },
    { id: 'f4', code: 'X904', name: '測試幣別不符', type: '基金', currency: 'USD', frequency: '月配', status: '持有中', navId: 'Z4,004' },
  ],
  trades: ['e', 'f1', 'f2', 'f3', 'f4'].map((id, i) => ({
    id: 't' + i, instrumentId: id, date: '2026-01-05', action: '買進', style: id === 'e' ? '單筆' : '小額',
    quantity: 100, price: 10, rate: id === 'f1' || id === 'f3' || id === 'f4' ? 30 : 1, amount: 30000, fee: 0, cash: 30000, note: '',
  })),
  dividends: [], cashflows: [],
  prices: [{ id: 'f1', code: 'X901', price: 10, rate: 31.5, updatedAt: '2026-08-01T12:00:00+08:00' }],
};
const NAVS = {
  'Z1,001': { nav: 12.34, date: '2026-09-29', currency: 'USD', name: '虛構美元基金' },
  Z2abc: { nav: 56.78, date: '2026-09-30', currency: 'TWD', name: '虛構台幣基金' },
  'Z4,004': { nav: 99.9, date: '2026-09-30', currency: 'TWD', name: '虛構幣別不符' },
};

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
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const server = JSON.parse(JSON.stringify(SEED));
  let backend = 'old';
  let usdTwd = 31.9;
  const asked = [];
  await page.route(API, async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    const json = (obj) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ apiVersion: backend === 'old' ? 'v19' : 'v20', ...obj }) });
    if (body.action === 'fundNavs') {
      asked.push(body.navIds);
      if (backend === 'old') return json({ ok: false, error: '未知的操作：fundNavs' });
      return json({ ok: true, navs: NAVS, usdTwd });
    }
    if (body.action === 'quotes') return json({ ok: true, quotes: { T001A: { price: 11, source: '測試' } } });
    if (body.action === 'etfDividends') return json({ ok: true, dividends: {} });
    if (body.action === 'save') {
      const list = server[body.entity] || (server[body.entity] = []);
      const i = list.findIndex((r) => r.id === body.record.id);
      if (i === -1) list.push({ ...body.record }); else list[i] = { ...body.record };
      return json({ ok: true, entity: body.entity, record: body.record });
    }
    return json({ ok: true, ...server });
  });

  await page.goto(BASE);
  await page.evaluate(({ seed, api }) => {
    localStorage.clear();
    for (const [k, list] of Object.entries(seed)) localStorage.setItem('pb.' + k, JSON.stringify(list.map((r) => ({ ...r, _synced: true }))));
    localStorage.setItem('pb.apiUrl', api);
  }, { seed: SEED, api: API });
  await page.reload();
  await page.waitForTimeout(700);
  await page.evaluate(() => document.querySelector('.tab[data-page="holdings"]').click());
  await page.waitForTimeout(250);
  const price = (id) => page.evaluate((id) => { const r = live('prices').find((p) => p.id === id); return r ? { price: r.price, rate: r.rate, at: String(r.updatedAt).slice(0, 10) } : null; }, id);

  console.log('\n── 後端還是舊版 ──');
  check('按鈕叫「更新現價」', (await page.locator('#quote-btn-text').innerText()) === '更新現價');
  await page.locator('#btn-refresh-prices').click();
  await page.waitForTimeout(900);
  const toast1 = await page.locator('#toast').innerText().catch(() => '');
  check('ETF 照樣更新', (await price('e'))?.price === 11);
  check('講出基金要重新部署 Code.gs', /重新部署 Code\.gs/.test(toast1), toast1);
  check('基金的價格沒被亂動', (await price('f1'))?.price === 10);

  console.log('\n── 後端更新了 ──');
  backend = 'new';
  await page.locator('#btn-refresh-prices').click();
  await page.waitForTimeout(900);
  const toast2 = await page.locator('#toast').innerText().catch(() => '');
  check('只問有填代碼的基金，同一檔不重複問', JSON.stringify(asked[asked.length - 1]) === JSON.stringify(['Z1,001', 'Z2abc', 'Z4,004']), JSON.stringify(asked[asked.length - 1]));
  const f1 = await price('f1');
  check('美元基金：淨值、當天匯率', f1 && f1.price === 12.34 && f1.rate === 31.9, JSON.stringify(f1));
  check('日期記的是「淨值是哪天的」，不是抓取時間', f1 && f1.at === '2026-09-29', f1 && f1.at);
  const f2 = await price('f2');
  check('台幣基金：匯率 1', f2 && f2.price === 56.78 && f2.rate === 1, JSON.stringify(f2));
  check('沒填代碼的不動', (await price('f3')) === null);
  check('幣別跟設定不同的不寫', (await price('f4')) === null);
  check('提示寫出哪一檔沒更新', /查不到 .*測試幣別不符/.test(toast2) && /基金 2 檔/.test(toast2), toast2);

  console.log('\n── 匯率這次沒抓到 ──');
  usdTwd = 0;
  await page.locator('#btn-refresh-prices').click();
  await page.waitForTimeout(900);
  check('沿用上次的匯率', (await price('f1'))?.rate === 31.9, JSON.stringify(await price('f1')));

  console.log('\n── 現價表單裡單檔抓取 ──');
  usdTwd = 32.05;
  await page.evaluate(() => openPriceSheet('f1'));
  await page.waitForTimeout(400);
  check('基金有填代碼就有「自動抓取」', await page.locator('#btn-fetch-price').isVisible());
  await page.locator('#btn-fetch-price').click();
  await page.waitForTimeout(700);
  const form = await page.evaluate(() => ({ price: parseNum($('p-price').value), rate: parseNum($('p-rate').value), hint: $('p-hint').textContent }));
  check('填好淨值、匯率，寫出是哪天的淨值', form.price === 12.34 && form.rate === 32.05 && /9\/29/.test(form.hint), JSON.stringify(form));
  await page.evaluate(() => closeSheet(true));
  await page.evaluate(() => openPriceSheet('f3'));
  await page.waitForTimeout(300);
  check('沒填代碼的基金沒有「自動抓取」', !(await page.locator('#btn-fetch-price').isVisible()));
  await page.evaluate(() => closeSheet(true));

  console.log('\n── 標的表單 ──');
  await page.evaluate(() => openInstrumentSheet({ type: '基金', record: instrumentById('f1') }));
  await page.waitForTimeout(300);
  check('基金有「淨值代碼」欄位', await page.locator('#i-navid-field').isVisible());
  check('帶出原本的代碼', (await page.inputValue('#i-navid')) === 'Z1,001');
  await page.fill('#i-navid', ' Z1,00 9 ');
  await page.evaluate(() => submitInstrument());
  await page.waitForTimeout(300);
  const saved = await page.evaluate(() => instrumentById('f1'));
  check('存的時候去掉空白、不改大小寫', saved.navId === 'Z1,009', saved.navId);
  check('編輯標的不會把備註清掉', saved.note === '這是備註', saved.note);
  await page.evaluate(() => openInstrumentSheet({ type: 'ETF', record: instrumentById('e') }));
  await page.waitForTimeout(300);
  check('ETF 沒有「淨值代碼」欄位', !(await page.locator('#i-navid-field').isVisible()));
  await page.evaluate(() => closeSheet(true));

  check('沒有 JS 錯誤', !errors.length, errors.join('；'));
  await browser.close();

  console.log('\n──────────────────────────────────────────────');
  if (problems.length) {
    console.log(`❌ ${problems.length} 項沒過\n  ` + problems.join('\n  '));
    process.exit(1);
  }
  console.log(`✅ ${pass} 項通過`);
})();
