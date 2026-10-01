/**
 * 基金也進配息行事曆：基準日、扣 30% 預扣稅、推估發放日、單筆與定期定額分開、出清的不列。
 * 執行：PW_CORE=<playwright-core 路徑> node scripts/test-fund-dividends.js
 *
 * 後端用 page.route 假裝；日期相對於今天產生；標的與數字全部虛構（repo 是公開的）。
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
 * F1：美元、月配，定期定額 100 單位 ＋ 單筆 50 單位。
 *     基金公司公布每單位 0.1，使用者記過的是 0.07（美國扣 30%）→ 要自動乘 0.7。
 *     使用者過去都是基準日後 5 天入帳 → 發放日推 5 天。
 *     75 天前那期記過了（超過兩個月，不列）；45 天前只記了定期定額那邊；15 天前兩邊都沒記。
 * F2：台幣，已經出清（200 天前賣光）—— 最近的配息不列、也不推下一期。
 * F3：持有中但沒填淨值代碼 —— 講一聲它不會出現。
 */
const SEED = {
  instruments: [
    { id: 'f1', code: 'X901', name: '測試月配美元', type: '基金', currency: 'USD', frequency: '月配', status: '持有中', navId: 'Z1,001' },
    { id: 'f2', code: 'X902', name: '測試已出清', type: '基金', currency: 'TWD', frequency: '月配', status: '已出清', navId: 'Z2,002' },
    { id: 'f3', code: 'X903', name: '測試沒代碼', type: '基金', currency: 'TWD', frequency: '季配', status: '持有中' },
  ],
  trades: [
    { id: 't1', instrumentId: 'f1', date: day(-400), action: '買進', style: '小額', quantity: 100, price: 10, rate: 30, amount: 30000, fee: 0, cash: 30000, note: '' },
    { id: 't2', instrumentId: 'f1', date: day(-400), action: '買進', style: '單筆', quantity: 50, price: 10, rate: 30, amount: 15000, fee: 0, cash: 15000, note: '' },
    { id: 't3', instrumentId: 'f2', date: day(-400), action: '買進', style: '小額', quantity: 80, price: 10, rate: 1, amount: 800, fee: 0, cash: 800, note: '' },
    { id: 't4', instrumentId: 'f2', date: day(-200), action: '賣出', style: '小額', quantity: 80, price: 11, rate: 1, amount: 880, fee: 0, cash: 880, note: '' },
    { id: 't5', instrumentId: 'f3', date: day(-400), action: '買進', style: '小額', quantity: 10, price: 10, rate: 1, amount: 100, fee: 0, cash: 100, note: '' },
  ],
  dividends: [
    { id: 'd1', instrumentId: 'f1', code: 'X901', style: '小額', exDate: day(-75), payDate: day(-70), perUnit: 0.07, units: 100, received: 224, note: '' },
    { id: 'd2', instrumentId: 'f1', code: 'X901', style: '小額', exDate: day(-45), payDate: day(-40), perUnit: 0.07, units: 100, received: 224, note: '' },
  ],
  cashflows: [],
  prices: [{ id: 'f1', code: 'X901', price: 10.5, rate: 32, updatedAt: day(-1) + 'T12:00:00+08:00' }],
};
const FUND_DIV = {
  'Z1,001': [
    { recordDate: day(-15), exDate: day(-14), perUnit: 0.1 },
    { recordDate: day(-45), exDate: day(-44), perUnit: 0.1 },
    { recordDate: day(-75), exDate: day(-74), perUnit: 0.1 },
  ],
  'Z2,002': [{ recordDate: day(-20), exDate: day(-19), perUnit: 0.05 }],
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
  await page.route(API, async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    const json = (obj) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ apiVersion: 'v21', ...obj }) });
    if (body.action === 'fundDividends') {
      return backend === 'old' ? json({ ok: false, error: '未知的操作：fundDividends' }) : json({ ok: true, dividends: FUND_DIV });
    }
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
  await page.evaluate(() => document.querySelector('.tab[data-page="report"]').click());
  await page.waitForTimeout(250);

  console.log('\n── 後端還是舊版 ──');
  check('行事曆出現（有填淨值代碼的基金）', await page.locator('#divcal-card').isVisible());
  check('卡片叫「配息行事曆」', (await page.locator('#divcal-card .card__title').innerText()) === '配息行事曆');
  await page.locator('#btn-divcal-refresh').click();
  await page.waitForTimeout(700);
  check('講清楚要重新部署 Code.gs', /Code\.gs/.test(await page.locator('#toast').innerText().catch(() => '')));

  console.log('\n── 抓到了 ──');
  backend = 'new';
  await page.locator('#btn-divcal-refresh').click();
  await page.waitForTimeout(800);
  const entries = await page.evaluate(() => divCalShown.map((e) => ({
    name: e.inst.name, style: e.style, ex: e.row.exDate, pay: e.row.payDate, per: e.row.perUnit, units: e.units, recorded: !!e.recorded, predicted: !!e.row.predicted,
  })));
  console.log('    ' + entries.map((e) => `${e.name} ${e.style} ${e.ex}${e.predicted ? '（預計）' : ''} 每單位 ${e.per} × ${e.units}${e.recorded ? ' 已記' : ''}`).join('\n    '));
  check('出清的基金不列', !entries.some((e) => e.name === '測試已出清'));
  check('超過兩個月的不列', !entries.some((e) => e.ex === day(-75)));
  const past = entries.filter((e) => !e.predicted);
  check('單筆和定期定額分開列（45、15 天前各兩列）', past.length === 4, `${past.length} 列`);
  check('日期用基準日（跟使用者的記法一樣）', past.every((e) => e.ex === day(-45) || e.ex === day(-15)));
  check('每單位自動乘 0.7（美國預扣稅）', past.every((e) => Math.abs(e.per - 0.07) < 1e-9), past.map((e) => e.per).join(' '));
  check('發放日照使用者過去的入帳推（基準日後 5 天）', past.every((e) => e.pay === (e.ex === day(-45) ? day(-40) : day(-10))));
  check('記過的那邊（45 天前定期定額）標已記，另一邊沒有', past.filter((e) => e.recorded).length === 1
    && past.find((e) => e.recorded).style === '小額' && past.find((e) => e.recorded).ex === day(-45));
  const pred = entries.filter((e) => e.predicted);
  check('還持有的推一期「預計」，兩邊各一列', pred.length === 2 && pred.every((e) => e.per === null));

  const html = await page.locator('#divcal-list').innerText();
  check('寫「基準」和「發放 約」', /基準 .* 發放 約/.test(html));
  check('預計那期寫「預計基準 … 前後」與「待公告」', /預計基準 .* 前後/.test(html) && /待公告/.test(html));
  check('名稱後面是銀行代碼和配息頻率', /測試月配美元\s*X901\s*月配/.test(html));
  check('美元基金的金額乘匯率（0.07 × 100 × 32 ＝ $224）', /約 \$224/.test(html));
  check('沒填淨值代碼的基金講一聲', /測試沒代碼 沒填淨值代碼/.test(html));
  check('「記下」只給已發放、沒記的（3 列）', (await page.locator('#divcal-list [data-divcal]').count()) === 3);

  console.log('\n── 漏記提醒 ──');
  const missing = await page.evaluate(() => findMissingDividends().map((m) => `${m.position.instrument.code}:${m.position.style}:${m.kind}:${m.count}`).sort());
  // 單筆那邊 75 天前那期也沒記 —— 行事曆只看兩個月，漏記提醒看一整年，所以是 3 期。
  // 沒填淨值代碼的照舊依頻率推算（買了一年多一次都沒領過）
  check('單筆那邊 3 期、定期定額那邊 1 期；沒代碼的照頻率推', JSON.stringify(missing) === JSON.stringify(['X901:單筆:official:3', 'X901:小額:official:1', 'X903:小額:never:0']), missing.join(' '));

  console.log('\n── 記下一筆 ──');
  const idx = await page.evaluate(() => divCalShown.findIndex((e) => e.style === '單筆' && !e.recorded && !e.row.predicted && e.row.exDate === divCalShown.filter((x) => !x.row.predicted)[0].row.exDate));
  await page.locator(`#divcal-list [data-divcal="${idx}"]`).click();
  await page.waitForTimeout(450);
  const form = await page.evaluate(() => ({
    inst: $('d-instrument').value, style: chipValue('d-style-chips', 'dstyle'), ex: $('d-exdate').value, pay: $('d-paydate').value,
    per: parseNum($('d-perunit').value), units: parseNum($('d-units').value), received: parseNum($('d-received').value), note: $('d-note').value,
  }));
  check('表單：單筆、基準日、推估發放日、扣稅後每單位、單筆的單位數',
    form.inst === 'f1' && form.style === '單筆' && form.ex === day(-45) && form.pay === day(-40) && form.per === 0.07 && form.units === 50,
    JSON.stringify(form));
  check('實領先用匯率估（0.07 × 50 × 32 ＝ 112），備註提醒照入帳改', form.received === 112 && /推估/.test(form.note), `${form.received} ${form.note}`);
  await page.locator('#dividend-form [type=submit]').click();
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => divCalShown.filter((e) => e.recorded).map((e) => `${e.style}:${e.row.exDate}`));
  check('存完那一列變成已記（定期定額那邊不受影響）', after.length === 2 && after.includes(`單筆:${day(-45)}`), after.join(' '));

  check('沒有 JS 錯誤', !errors.length, errors.join('；'));
  await browser.close();

  console.log('\n──────────────────────────────────────────────');
  if (problems.length) {
    console.log(`❌ ${problems.length} 項沒過\n  ` + problems.join('\n  '));
    process.exit(1);
  }
  console.log(`✅ ${pass} 項通過`);
})();
