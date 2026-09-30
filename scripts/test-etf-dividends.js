/**
 * ETF 配息公告：行事曆、從公告記一筆、漏記提醒改用公告。
 * 執行：PW_CORE=<playwright-core 路徑> node scripts/test-etf-dividends.js
 *
 * 後端用 page.route 假裝，公告的日期都相對於「今天」產生，哪天跑結果都一樣。
 * 標的和數字全部虛構（repo 是公開的）。
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

const pad = (n) => String(n).padStart(2, '0');
const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/*
 * T001A：一直持有 2,000 股。三期公告：
 *   60 天前除息（已經記了）、30 天前除息 10 天前發放（沒記 → 要能記、漏記提醒要講）、
 *   10 天後除息（金額待公告）
 * T002：44 天前才買 —— 45 天前那期領不到，不該列；15 天前那期 5 天後才發，列出但還不能記
 * T003：從來不配息，公告是空的 —— 不能再被「一次都沒領過」追著問
 */
const SEED = {
  instruments: [
    { id: 'a', code: 'T001A', name: '測試高息動能', type: 'ETF', currency: 'TWD', frequency: '月配', status: '持有中' },
    { id: 'b', code: 'T002', name: '測試科技優息', type: 'ETF', currency: 'TWD', frequency: '月配', status: '持有中' },
    { id: 'c', code: 'T003', name: '測試成長不配', type: 'ETF', currency: 'TWD', frequency: '季配', status: '持有中' },
  ],
  trades: [
    { id: 't1', instrumentId: 'a', date: day(-300), action: '買進', style: '單筆', quantity: 2000, price: 10, rate: 1, amount: 20000, fee: 28, cash: 20028, note: '' },
    { id: 't2', instrumentId: 'b', date: day(-44), action: '買進', style: '單筆', quantity: 600, price: 20, rate: 1, amount: 12000, fee: 17, cash: 12017, note: '' },
    { id: 't3', instrumentId: 'c', date: day(-300), action: '買進', style: '單筆', quantity: 1000, price: 15, rate: 1, amount: 15000, fee: 21, cash: 15021, note: '' },
  ],
  dividends: [
    { id: 'd1', instrumentId: 'a', code: 'T001A', style: '', exDate: day(-60), payDate: day(-39), perUnit: 0.5, units: 2000, received: 990, note: '' },
  ],
  cashflows: [], prices: [],
};

const OFFICIAL = {
  T001A: [
    { exDate: day(10), recordDate: day(16), payDate: day(30), perUnit: null },
    { exDate: day(-30), recordDate: day(-24), payDate: day(-10), perUnit: 0.5 },
    { exDate: day(-60), recordDate: day(-54), payDate: day(-40), perUnit: 0.5 },
  ],
  T002: [
    { exDate: day(-15), recordDate: day(-9), payDate: day(5), perUnit: 0.3 },
    { exDate: day(-45), recordDate: day(-39), payDate: day(-20), perUnit: 0.3 },
  ],
  T003: [],
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

  let backendKnows = false;   // 先假裝後端還是舊版
  const server = JSON.parse(JSON.stringify(SEED));
  await page.route(API, async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    const json = (obj) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ apiVersion: 'v19', ...obj }) });
    if (body.action === 'etfDividends') {
      return backendKnows
        ? json({ ok: true, dividends: OFFICIAL })
        : json({ ok: false, error: '未知的操作：etfDividends' });
    }
    if (body.action === 'quotes') return json({ ok: true, quotes: { T001A: { price: 11, source: '測試' }, T002: { price: 21, source: '測試' }, T003: { price: 16, source: '測試' } } });
    // 存過的要記住：同步時 App 會拿伺服器的資料回來對，假後端忘記的話剛存的就被蓋掉了
    if (body.action === 'save') {
      const list = server[body.entity] || (server[body.entity] = []);
      const i = list.findIndex((r) => r.id === body.record.id);
      if (i === -1) list.push({ ...body.record }); else list[i] = { ...body.record };
      return json({ ok: true, entity: body.entity, record: body.record });
    }
    if (body.action === 'remove') {
      server[body.entity] = (server[body.entity] || []).filter((r) => r.id !== body.id);
      return json({ ok: true, entity: body.entity, id: body.id });
    }
    return json({ ok: true, ...server });
  });

  await page.goto(BASE);
  await page.evaluate(({ seed, api }) => {
    localStorage.clear();
    for (const [k, list] of Object.entries(seed)) {
      localStorage.setItem('pb.' + k, JSON.stringify(list.map((r) => ({ ...r, _synced: true }))));
    }
    localStorage.setItem('pb.apiUrl', api);
  }, { seed: SEED, api: API });
  await page.reload();
  await page.waitForTimeout(700);
  const go = (tab) => page.evaluate((t) => document.querySelector(`.tab[data-page="${t}"]`).click(), tab);

  console.log('\n── 後端還沒更新 ──');
  await go('holdings');
  await page.waitForTimeout(200);
  await page.locator('#btn-refresh-prices').click();
  await page.waitForTimeout(900);
  const toastText = await page.locator('#toast').innerText().catch(() => '');
  check('講清楚要重新部署 Code.gs', /Code\.gs/.test(toastText), toastText);
  const priced = await page.evaluate(() => live('prices').length);
  check('現價照樣更新', priced === 3, `更新了 ${priced} 檔`);

  console.log('\n── 抓到公告之前 ──');
  await go('report');
  await page.waitForTimeout(200);
  check('行事曆出現，提示怎麼抓', /還沒抓過/.test(await page.locator('#divcal-sub').innerText()));
  const inferred = await page.evaluate(() => findMissingDividends().map((m) => `${m.position.instrument.code}:${m.kind}`));
  check('沒有公告時照頻率推算（T003 會被問「一次都沒領過」）', inferred.includes('T003:never'), inferred.join(' '));

  console.log('\n── 抓到公告 ──');
  backendKnows = true;
  await page.locator('#btn-divcal-refresh').click();
  await page.waitForTimeout(800);

  const rows = await page.evaluate(() => [...document.querySelectorAll('#divcal-list > *')].map((el) => (
    el.classList.contains('divcal__today') ? '—今天—' : el.querySelector('.divcal__name').textContent + '｜' + el.querySelector('.divcal__dates').textContent
  )));
  console.log('    ' + rows.join('\n    '));
  const names = rows.filter((r) => r !== '—今天—');
  check('只列除息前有持有的（T002 45 天前那期不列）', names.length === 4, `${names.length} 列`);
  const exOrder = await page.evaluate(() => divCalShown.map((e) => e.row.exDate));
  check('照除息日先後排', exOrder.every((d, i) => i === 0 || exOrder[i - 1] <= d), exOrder.join(' '));
  check('「今天」在已除息和還沒除息之間', rows.indexOf('—今天—') === 3, `在第 ${rows.indexOf('—今天—') + 1} 個`);

  const html = await page.locator('#divcal-list').innerHTML();
  check('未來那期標「待公告」', /待公告/.test(html));
  check('約可領＝每股 × 除息前持有股數（0.5 × 2,000 ＝ $1,000）', /約 \$1,000/.test(html));
  check('記過的那期標「已記」', /已記 ✓/.test(html));
  const recButtons = await page.locator('#divcal-list [data-divcal]').count();
  check('只有「已發放、沒記」的那期有「記下」', recButtons === 1, `${recButtons} 顆`);

  const missing = await page.evaluate(() => findMissingDividends().map((m) => `${m.position.instrument.code}:${m.kind}:${m.count}`));
  check('漏記提醒改用公告：T001A 那一期', missing.includes('T001A:official:1'), missing.join(' '));
  check('T003 不配息，公告是空的 —— 不再追問', !missing.some((m) => m.startsWith('T003')), missing.join(' '));
  check('T002 還沒發放 —— 不算漏記', !missing.some((m) => m.startsWith('T002')), missing.join(' '));

  console.log('\n── 從公告記一筆 ──');
  await page.locator('#divcal-list [data-divcal]').click();
  await page.waitForTimeout(450);
  const form = await page.evaluate(() => ({
    inst: $('d-instrument').value, ex: $('d-exdate').value, pay: $('d-paydate').value,
    per: parseNum($('d-perunit').value), units: parseNum($('d-units').value), received: parseNum($('d-received').value),
  }));
  const want = { inst: 'a', ex: day(-30), pay: day(-10), per: 0.5, units: 2000, received: 1000 };
  check('表單照公告與持股填好', JSON.stringify(form) === JSON.stringify(want), JSON.stringify(form));

  await page.fill('#d-received', '990');   // 實際入帳被扣了 10 元匯費
  await page.locator('#dividend-form [type=submit]').click();
  await page.waitForTimeout(600);
  const after = await page.locator('#divcal-list').innerHTML();
  check('存完那一期變成「已記」', (after.match(/已記 ✓/g) || []).length === 2);
  check('「記下」按鈕沒了', (await page.locator('#divcal-list [data-divcal]').count()) === 0);
  const missingAfter = await page.evaluate(() => findMissingDividends().length);
  check('漏記提醒跟著消失', missingAfter === 0, `還有 ${missingAfter} 項`);

  console.log('\n── 首頁的漏記提醒也能直接記 ──');
  // 把剛記的那筆刪掉，讓它回到「沒記」
  await page.evaluate(() => {
    const d = live('dividends').find((x) => x.received === 990 && x.id !== 'd1');
    remove('dividends', d.id);
  });
  await page.waitForTimeout(500);
  await go('record');
  await page.waitForTimeout(250);
  const alertMeta = await page.locator('#missing-list .alert__meta').first().innerText().catch(() => '');
  check('提醒寫出公告的除息日、發放日、每股', /除息 .* 發放 .* 每股 0\.5/.test(alertMeta), alertMeta);
  await page.locator('#missing-list .alert__item').first().click();
  await page.waitForTimeout(450);
  const form2 = await page.evaluate(() => ({ pay: $('d-paydate').value, per: parseNum($('d-perunit').value) }));
  check('點「去記」整筆照公告填好', form2.pay === day(-10) && form2.per === 0.5, JSON.stringify(form2));
  await page.evaluate(() => closeSheet(true));

  console.log('\n── 遮住金額 ──');
  await page.evaluate(() => { state.privacy = true; render(); });
  await go('report');
  await page.waitForTimeout(200);
  const masked = await page.locator('#divcal-list').innerText();
  check('行事曆的金額也遮住', !/\$\d/.test(masked), masked.slice(0, 80));

  check('沒有 JS 錯誤', !errors.length, errors.join('；'));
  await browser.close();

  console.log('\n──────────────────────────────────────────────');
  if (problems.length) {
    console.log(`❌ ${problems.length} 項沒過\n  ` + problems.join('\n  '));
    process.exit(1);
  }
  console.log(`✅ ${pass} 項通過`);
})();
