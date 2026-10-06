/**
 * 券商成交資料的解析（brokerItems），不需要真的 PDF：
 * 直接餵「pdf.js 會讀出來的那種文字片段＋座標」，標的與數字全部虛構。
 * 執行：PW_CORE=<playwright-core 路徑> node scripts/test-broker-parse.js
 *
 * 守兩個實際踩到的坑：
 *   1. 同一檔分兩次成交：主表格兩列、下方彙總只合併成一列。
 *      以前照順序配，第二列配不到代號就被丟掉了
 *   2. 「應收付金額」有時折成「應收／付／金額」三行，表頭範圍太窄就讀不到實收
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

const it = (y, x, w, s) => ({ page: 1, y, x, w, s });

/** 表頭：wrapNet 為 true 時「應收付金額」折成三行（新的版面），否則是兩行 */
function header(wrapNet) {
  const h = [
    it(737, 80, 13, '類別'), it(737, 106, 13, '股票'), it(737, 137, 13, '數量'), it(737, 166, 27, '現沖數量'),
    it(737, 200, 20, '成交價'), it(737, 228, 13, '價金'), it(737, 250, 20, '手續費'), it(737, 277, 20, '交易稅'),
    it(742, 305, 30, '融資金額/'), it(731, 303, 34, '融券擔保品'),
  ];
  return h.concat(wrapNet
    ? [it(748, 505, 13, '應收'), it(737, 508, 7, '付'), it(725, 505, 13, '金額')]
    : [it(742, 498, 20, '應收付'), it(731, 501, 13, '金額')]);
}

/** 一列成交。名稱被折成上下兩段，跟真的對帳單一樣 */
function row(y, kind, top, bottom, qty, price, amount, fee, tax, net) {
  return [
    it(y, 80, 13, kind), it(y + 5, 103, 20, top), it(y - 6, 106, 13, bottom),
    it(y, 150, 10, qty), it(y, 191, 4, '0'), it(y, 205, 17, price), it(y, 226, 20, amount),
    it(y, 263, 8, fee), it(y, 290, 8, tax), it(y, 378, 4, '0'), it(y, 510, 15, net),
  ];
}

const intro = [it(772, 194, 67, '民國 115 年 9 月 9 日'), it(772, 262, 54, '的成交資料如下！')];

const CASES = {
  // 同一檔分兩次成交 ＋ 另一檔一次，新版表頭
  split: [
    ...intro, ...header(true),
    ...row(705, '現賣', '測試高', '息甲', '3', '12.10', '36', '1', '0', '35'),
    ...row(678, '現賣', '測試高', '息甲', '997', '12.30', '12,263', '17', '12', '12,234'),
    ...row(651, '現買', '測試科', '技乙', '200', '25.50', '5,100', '7', '0', '-5,107'),
    it(569, 100, 58, 'T001A (測試高息甲)'), it(569, 228, 27, '現股賣出'),
    it(554, 100, 58, 'T002 (測試科技乙)'), it(554, 228, 27, '現股買進'),
  ],
  // 舊版表頭，一檔一列（原本就能讀的樣子，不能改壞）
  plain: [
    ...intro, ...header(false),
    ...row(705, '現買', '測試科', '技乙', '600', '28.38', '17,028', '24', '0', '-17,052'),
    it(569, 100, 58, 'T002 (測試科技乙)'), it(569, 228, 27, '現股買進'),
  ],
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
  const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.waitForTimeout(400);
  const parse = (items) => page.evaluate((items) => parseStatement(items), items);

  console.log('\n── 同一檔分兩次成交（新版表頭）──');
  const a = await parse(CASES.split);
  check('三列都讀到', a.length === 3, `${a.length} 列`);
  check('兩次成交都配到同一個代號', a[0] && a[1] && a[0].code === 'T001A' && a[1].code === 'T001A', a.map((x) => x.code).join(' '));
  check('另一檔照名稱配到自己的代號', a[2] && a[2].code === 'T002' && a[2].action === '買進');
  check('數量、價格各自分開', a[0] && a[0].qty === 3 && a[0].price === 12.1 && a[1].qty === 997 && a[1].price === 12.3);
  check('「應收／付／金額」折成三行也讀得到實收', a[0] && a[1] && a[0].cash === 35 && a[1].cash === 12234, `${a[0] && a[0].cash} ${a[1] && a[1].cash}`);
  check('賣出的交易稅併進手續費、寫進備註', a[1] && a[1].fee === 29 && a[1].note === '手續費17+交易稅12');
  check('買進的實扣是正數', a[2] && a[2].cash === 5107);
  check('日期是民國轉西元', a.every((x) => x.date === '2026-09-09'));

  console.log('\n── 舊版表頭，一檔一列 ──');
  const b = await parse(CASES.plain);
  check('照樣讀得到', b.length === 1 && b[0].code === 'T002' && b[0].qty === 600 && b[0].cash === 17052, JSON.stringify(b[0]));

  check('沒有 JS 錯誤', !errors.length, errors.join('；'));
  await browser.close();

  console.log('\n──────────────────────────────────────────────');
  if (problems.length) {
    console.log(`❌ ${problems.length} 項沒過\n  ` + problems.join('\n  '));
    process.exit(1);
  }
  console.log(`✅ ${pass} 項通過`);
})();
