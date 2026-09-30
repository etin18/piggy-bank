/**
 * 對帳單 PDF 匯入：用真的對帳單走一遍「選檔 → 密碼 → 讀出來 → 填表單 → 存 → 變成已記過」。
 * 執行：PW_CORE=<playwright-core 路徑> node scripts/test-pdf-import.js
 *
 * 對帳單是真實的財務資料，**不進版控**（.gitignore 擋了 *.pdf）。
 * 這支測試讀的是專案根目錄下本機的那幾份，沒有就跳過那一項。
 * 密碼用環境變數給，不寫在程式裡：
 *   PDF_PW_BANK=… PDF_PW_BROKER=… node scripts/test-pdf-import.js
 *
 * 期望值是照 PDF 上印的數字手抄的，所以也跟 PDF 一樣只留在本機。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require(process.env.PW_CORE);

const BASE = 'http://localhost:8789';
const ROOT = path.join(__dirname, '..');
const PW_BANK = process.env.PDF_PW_BANK || '';
const PW_BROKER = process.env.PDF_PW_BROKER || '';

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
 * 資料（標的、期望值）放在本機的 scripts/pdf-fixtures.local.json，不進版控 ——
 * 期望值是照對帳單抄的，那就是使用者真實的交易紀錄。格式：
 *   {
 *     "seed":   { "instruments": [...], "trades": [...], ... },   // 測試前灌進 App 的資料
 *     "expect": { "檔名.pdf": [ { "kind": "trade", "code": "…", "qty": …, … } ] },
 *     "styles": { "檔名.pdf": ["小額", "單筆", …] }                // 單據沒寫、要自己補出的型態
 *   }
 */
const FIXTURE = path.join(__dirname, 'pdf-fixtures.local.json');
if (!fs.existsSync(FIXTURE)) {
  console.log('沒有 scripts/pdf-fixtures.local.json（本機專用，不進版控），跳過。');
  process.exit(0);
}
const { seed: SEED, expect: EXPECT, styles: STYLES = {} } = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const FILES = Object.keys(EXPECT);
const passwordFor = (file) => (/^ETF/.test(file) ? PW_BROKER : PW_BANK);

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
  // 擋掉 Service Worker：它接手時會重新整理一次，會打斷灌資料
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(BASE);
  await page.evaluate((seed) => {
    localStorage.clear();
    for (const [k, list] of Object.entries(seed)) {
      localStorage.setItem('pb.' + k, JSON.stringify(list.map((r) => ({ ...r, _synced: true }))));
    }
  }, SEED);
  await page.reload();
  await page.waitForTimeout(500);

  const upload = async (file) => {
    await page.locator('#import-file').setInputFiles(path.join(ROOT, file));
    await page.waitForFunction(() => !importState.busy && importState.bytes, null, { timeout: 15000 });
    await page.waitForTimeout(150);
  };
  const typePassword = async (pw) => {
    await page.fill('#import-pw', pw);
    await page.locator('#import-password [type=submit]').click();
    await page.waitForFunction(() => !importState.busy, null, { timeout: 15000 });
    await page.waitForTimeout(150);
  };
  const items = () => page.evaluate(() => importState.items.map(resolveImport));

  for (const file of FILES) {
    const pw = passwordFor(file);
    console.log(`\n── ${file} ──`);
    if (!fs.existsSync(path.join(ROOT, file))) { console.log('  （本機沒有這份，跳過）'); continue; }
    if (!pw) { console.log('  （沒給密碼，跳過。用 PDF_PW_BANK／PDF_PW_BROKER 給）'); continue; }

    await upload(file);
    const asked = await page.locator('#import-password').isVisible();
    if (asked) {
      await typePassword('wrong-password');
      const status = await page.locator('#import-status').innerText();
      check('密碼打錯會講', /密碼不對/.test(status), status);
      await typePassword(pw);
    } else {
      check('記住的密碼自動打開', true);
    }

    const got = await items();
    const want = EXPECT[file];
    check(`讀到 ${want.length} 筆`, got.length === want.length, `實際 ${got.length} 筆`);
    want.forEach((w, i) => {
      const g = got[i] || {};
      const diff = Object.entries(w).filter(([k, v]) => (typeof v === 'number' ? Math.abs((g[k] || 0) - v) > 1e-6 : g[k] !== v));
      check(`第 ${i + 1} 筆 ${w.code} 欄位都對`, !diff.length, diff.map(([k, v]) => `${k} 應為 ${v}，讀到 ${g[k]}`).join('；'));
      check(`第 ${i + 1} 筆用代碼對到 App 的標的`, !!g.instrumentId, g.code);
    });

    // 單據沒寫的（基金配息是哪一邊、ETF 是不是定期定額），要自己補出來
    (STYLES[file] || []).forEach((style, i) => {
      if (style === null) return;
      check(`第 ${i + 1} 筆補出的型態是「${style}」`, got[i] && got[i].style === style, got[i] && got[i].style);
    });

    // 點第一筆 → 表單照單據填好 → 存 → 回清單，那筆變成「已經記過」
    await page.locator('#import-list [data-import="0"]').click();
    await page.waitForTimeout(450);
    const isTrade = want[0].kind === 'trade';
    const form = await page.evaluate((isTrade) => (isTrade
      ? { date: $('t-date').value, qty: parseNum($('t-qty').value), cash: parseNum($('t-cash').value), inst: $('t-instrument').value }
      : { ex: $('d-exdate').value, pay: $('d-paydate').value, units: parseNum($('d-units').value), received: parseNum($('d-received').value), inst: $('d-instrument').value }), isTrade);
    check('表單照單據填好', isTrade
      ? form.date === want[0].date && form.qty === want[0].qty && form.cash === want[0].cash && !!form.inst
      : form.ex === want[0].exDate && form.pay === want[0].payDate && form.units === want[0].units && form.received === want[0].received && !!form.inst,
    JSON.stringify(form));

    await page.locator(isTrade ? '#trade-form [type=submit]' : '#dividend-form [type=submit]').click();
    await page.waitForTimeout(600);
    check('存完回到匯入清單', await page.locator('#import-sheet').isVisible());
    const after = await items();
    check('剛存的那筆變成「已經記過」', after[0] && after[0].done);

    // 同一份再選一次：密碼記住了，自動打開；剛存的那筆認得出來
    await upload(file);
    check('第二次不用再打密碼', !(await page.locator('#import-password').isVisible()));
    check('重複匯入認得出已經記過', (await items())[0].done);

    await page.evaluate(() => closeSheet(true));
    await page.waitForTimeout(200);
  }

  // 不是對帳單的 PDF：講清楚認得哪些，不要默默什麼都沒有
  console.log('\n── 不認得的 PDF ──');
  const blank = path.join(os.tmpdir(), 'pb-blank-test.pdf');
  fs.writeFileSync(blank, '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
  await page.locator('#import-file').setInputFiles(blank);
  await page.waitForFunction(() => !importState.busy && importState.bytes, null, { timeout: 15000 });
  const status = await page.locator('#import-status').innerText();
  check('講出目前認得哪幾種單據', /目前認得/.test(status), status);

  check('沒有 JS 錯誤', !errors.length, errors.join('；'));
  await browser.close();

  console.log('\n──────────────────────────────────────────────');
  if (problems.length) {
    console.log(`❌ ${problems.length} 項沒過\n  ` + problems.join('\n  '));
    process.exit(1);
  }
  console.log(`✅ ${pass} 項通過`);
})();
