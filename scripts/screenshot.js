/**
 * 用 Playwright 開 App、灌入測試資料、走完主要流程並截圖檢查版面。
 * 執行：PW_CORE=<playwright-core 路徑> node scripts/screenshot.js
 *
 * 順便做兩件事：
 *   1. 收集 console 錯誤 —— 版面對不對用眼睛看，JS 有沒有炸掉要靠這個
 *   2. 核對算出來的數字 —— 平均成本、帳戶餘額、配息統計都在下面手算過一遍
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { chromium } = require(process.env.PW_CORE);

const OUT = path.join(__dirname, '..', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const BASE = 'http://localhost:8789';

/**
 * npx 快取裡的 playwright-core 常常比已下載的瀏覽器新，
 * 直接 launch 會叫你 `npx playwright install`。
 * 這裡自己去快取挑一個裝好的 headless shell 來用，版本差一點沒關係。
 */
function findChromium() {
  if (process.env.PW_CHROME) return process.env.PW_CHROME;

  const base = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  if (!fs.existsSync(base)) return undefined;

  const candidates = fs.readdirSync(base)
    .filter((d) => d.startsWith('chromium_headless_shell-') || d.startsWith('chromium-'))
    .sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop()));

  for (const dir of candidates) {
    for (const rel of [
      'chrome-headless-shell-mac-arm64/chrome-headless-shell',
      'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    ]) {
      const full = path.join(base, dir, rel);
      if (fs.existsSync(full)) return full;
    }
  }
  return undefined;
}

/* ==========================================================================
   測試資料

   兩檔 ETF ＋ 一檔台幣計價的月配基金，含一筆「2025 之前」的概估期初。
   數字刻意取得好驗算，期望值寫在最下面的 EXPECT。
   ========================================================================== */

const SEED = {
  instruments: [
    { id: 'i1', code: '0056', name: '元大高股息', type: 'ETF', frequency: '季配', status: '持有中', note: '' },
    { id: 'i2', code: '00919', name: '群益台灣精選高息', type: 'ETF', frequency: '季配', status: '持有中', note: '' },
    { id: 'i3', code: '', name: '安聯收益成長', type: '基金', frequency: '月配', status: '持有中', note: '' },
  ],

  trades: [
    // 基金・單筆：2025 之前的期初（概估，整筆算）
    { id: 't1', instrumentId: 'i3', code: '安聯收益成長', date: 'PRE2025', action: '買進', style: '單筆',
      quantity: 800, price: 37.5, amount: 30000, fee: 0, cash: 0, note: '概估' },

    // 基金・定期定額：四期，每期 5,000
    { id: 't2', instrumentId: 'i3', code: '安聯收益成長', date: '2025-01-06', action: '買進', style: '小額',
      quantity: 125.0000, price: 40.00, amount: 5000, fee: 25, cash: 5025, note: '' },
    { id: 't3', instrumentId: 'i3', code: '安聯收益成長', date: '2025-07-07', action: '買進', style: '小額',
      quantity: 121.2121, price: 41.25, amount: 5000, fee: 25, cash: 5025, note: '' },
    { id: 't4', instrumentId: 'i3', code: '安聯收益成長', date: '2026-03-05', action: '買進', style: '小額',
      quantity: 114.9425, price: 43.50, amount: 5000, fee: 25, cash: 5025, note: '' },
    { id: 't5', instrumentId: 'i3', code: '安聯收益成長', date: '2026-09-05', action: '買進', style: '小額',
      quantity: 111.6071, price: 44.80, amount: 5000, fee: 25, cash: 5025, note: '' },

    // ETF：0056 買兩次沒賣過
    { id: 't6', instrumentId: 'i1', code: '0056', date: '2025-12-10', action: '買進', style: '',
      quantity: 2000, price: 36.5, amount: 73000, fee: 104, cash: 73104, note: '' },
    { id: 't7', instrumentId: 'i1', code: '0056', date: '2026-06-12', action: '買進', style: '',
      quantity: 1000, price: 37.2, amount: 37200, fee: 53, cash: 37253, note: '' },

    // ETF：00919 買 → 全賣 → 跌下來又買回，這是兩個獨立的持有回合
    { id: 't8', instrumentId: 'i2', code: '00919', date: '2026-03-18', action: '買進', style: '',
      quantity: 1000, price: 23.8, amount: 23800, fee: 34, cash: 23834, note: '' },
    { id: 't9', instrumentId: 'i2', code: '00919', date: '2026-05-20', action: '賣出', style: '',
      quantity: 1000, price: 26.5, amount: 26500, fee: 65, cash: 26435, note: '' },
    { id: 't10', instrumentId: 'i2', code: '00919', date: '2026-07-10', action: '買進', style: '',
      quantity: 1000, price: 22.9, amount: 22900, fee: 33, cash: 22933, note: '' },
  ],

  dividends: [
    { id: 'd1', instrumentId: 'i1', code: '0056', style: '', exDate: '2026-01-20', payDate: '2026-01-22',
      perUnit: 1.05, units: 2000, received: 2078, note: '' },
    { id: 'd2', instrumentId: 'i1', code: '0056', style: '', exDate: '2026-04-21', payDate: '2026-04-23',
      perUnit: 0.85, units: 2000, received: 1683, note: '' },
    { id: 'd3', instrumentId: 'i1', code: '0056', style: '', exDate: '2026-07-22', payDate: '2026-07-24',
      perUnit: 0.90, units: 3000, received: 2643, note: '' },

    // 這筆的除息日落在 00919 第一段持有期間內，要歸到已出清那一段
    { id: 'd4', instrumentId: 'i2', code: '00919', style: '', exDate: '2026-04-16', payDate: '2026-04-18',
      perUnit: 0.72, units: 1000, received: 713, note: '' },

    // 基金：單筆與定期定額的配息分開發、分開記
    { id: 'd5', instrumentId: 'i3', code: '安聯收益成長', style: '單筆', exDate: '2026-03-15', payDate: '2026-03-16',
      perUnit: 0.25, units: 800, received: 200, note: '' },
    { id: 'd6', instrumentId: 'i3', code: '安聯收益成長', style: '小額', exDate: '2026-03-15', payDate: '2026-03-16',
      perUnit: 0.25, units: 361.1546, received: 90, note: '' },
    { id: 'd7', instrumentId: 'i3', code: '安聯收益成長', style: '單筆', exDate: '2026-06-15', payDate: '2026-06-16',
      perUnit: 0.26, units: 800, received: 208, note: '' },
    { id: 'd8', instrumentId: 'i3', code: '安聯收益成長', style: '小額', exDate: '2026-06-15', payDate: '2026-06-16',
      perUnit: 0.26, units: 361.1546, received: 94, note: '' },
    { id: 'd9', instrumentId: 'i3', code: '安聯收益成長', style: '單筆', exDate: '2026-08-15', payDate: '2026-08-16',
      perUnit: 0.26, units: 800, received: 208, note: '' },
    { id: 'd10', instrumentId: 'i3', code: '安聯收益成長', style: '小額', exDate: '2026-08-15', payDate: '2026-08-16',
      perUnit: 0.26, units: 361.1546, received: 94, note: '' },
  ],

  cashflows: [
    { id: 'c1', date: '2025-12-01', account: '券商', action: '存入', amount: 150000, note: '' },
    { id: 'c2', date: 'PRE2025', account: '基金', action: '存入', amount: 50000, note: '期初餘額' },
    { id: 'c3', date: '2025-06-01', account: '基金', action: '存入', amount: 20000, note: '' },
  ],

  prices: [
    { id: 'i1', code: '0056', price: 38.2, updatedAt: '2026-09-08T01:00:00.000Z' },
    { id: 'i2', code: '00919', price: 24.5, updatedAt: '2026-09-08T01:00:00.000Z' },
    { id: 'i3', code: '安聯收益成長', price: 46.2, updatedAt: '2026-09-08T01:00:00.000Z' },
  ],
};

/* 手算的期望值（今天在 2026 年 9 月，所以「已過月數」＝ 9）

   0056        3,000 股，金額 110,200 ＋ 手續費 157 → 部位成本 110,357
               平均成本 36.7333，現價 38.2 → 市值 114,600，未實現 +4,243

   00919       第一段：23,834 買進 → 26,435 賣出，已實現 +2,601（配息 713 也歸這段）
               第二段：22,900 ＋ 33 ＝ 22,933，平均成本 22.9（★ 不是跟第一段混算的 23.35）
               現價 24.5 → 市值 24,500，未實現 +1,567

   安聯・單筆   800 單位，成本 30,000，平均 37.50 → 市值 36,960，未實現 +6,960
   安聯・定期   472.7617 單位，金額 20,000 ＋ 手續費 100 ＝ 20,100
               平均 42.3046 → 市值 21,841.6，未實現 +1,741.6
   安聯合計     1,272.7617 單位，成本 50,100，市值 58,801.6，未實現 +8,701.6

   券商餘額 150,000 −73,104 −37,253 −23,834 +26,435 −22,933 +7,117 ＝ 26,428
   基金餘額  50,000 +20,000 −20,100 +894 ＝ 50,794
     （期初那筆申購不扣款，錢在期初餘額之前就付掉了）

   2026 配息  ETF 2,078+1,683+2,643+713 ＝ 7,117
              基金 200+90+208+94+208+94 ＝ 894
              合計 8,011 ÷ 9 ＝ 890

   總市值 114,600 + 24,500 + 58,801.6 ＝ 197,902
   總成本 110,357 + 22,933 + 50,100    ＝ 183,390
   未實現 ＝ +14,512 */
const EXPECT = {
  'summary-total': '$8,011',
  'summary-avg': '$890',
  'rp-total': '$8,011',
  'rp-etf': '$7,117',
  'rp-fund': '$894',
  'bal-etf': '$26,428',
  'bal-fund': '$50,794',
  'hd-value': '$197,902',
  'hd-cost': '$183,390',
  'hd-pl': '+$14,512',
  'rp-real': '+$2,601',
};

/* ========================================================================== */

const problems = [];

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  console.log(`  📸 ${name}`);
}

async function textOf(page, id) {
  return (await page.locator(`#${id}`).innerText()).trim();
}

async function check(page, id, expected, label) {
  const actual = await textOf(page, id);
  const ok = actual.replace(/\s+/g, ' ').includes(expected);
  console.log(`  ${ok ? '✅' : '❌'} ${label}：${actual}${ok ? '' : `（應為 ${expected}）`}`);
  if (!ok) problems.push(`${label} 得到「${actual}」，應為「${expected}」`);
}

async function run() {
  const browser = await chromium.launch({ executablePath: findChromium() });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
  });
  const page = await context.newPage();

  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto(BASE, { waitUntil: 'networkidle' });

  // 灌資料。標成 _synced 讓它們不會排進待同步佇列
  await page.evaluate((seed) => {
    for (const [entity, rows] of Object.entries(seed)) {
      localStorage.setItem('pb.' + entity, JSON.stringify(rows.map((r) => ({ ...r, _synced: true }))));
    }
    localStorage.setItem('pb.theme', 'light');
  }, SEED);

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(300);

  console.log('\n── 記錄頁 ──');
  await shot(page, '01-記錄');
  await check(page, 'summary-total', EXPECT['summary-total'], '今年配息');
  await check(page, 'summary-avg', EXPECT['summary-avg'], '平均每月');

  console.log('\n── 選 ETF、展開動作 ──');
  await page.locator('.picker__btn[data-category="ETF"]').click();
  await page.waitForTimeout(200);
  await shot(page, '02-選ETF');

  console.log('\n── ETF 買進表單 ──');
  await page.locator('.action[data-action="buy"]').click();
  await page.waitForTimeout(400);

  await page.selectOption('#t-instrument', 'i1');
  await page.locator('#t-unit-chips .chip[data-unit="張"]').click();
  await page.fill('#t-qty', '2');
  await page.fill('#t-price', '36.5');
  await page.waitForTimeout(200);
  await shot(page, '03-ETF買進');

  // ETF 的成交金額跟著股價跑，不該出現常用金額快捷
  const etfQuick = await page.locator('#t-amount-quick').isVisible();
  console.log(`  ${!etfQuick ? '✅' : '❌'} ETF 買進沒有常用金額快捷`);
  if (etfQuick) problems.push('ETF 買進不該出現常用金額快捷');
  const autoAmount = await page.inputValue('#t-amount');
  const autoCash = await page.inputValue('#t-cash');
  const lotHint = await textOf(page, 't-qty-hint');
  console.log(`  ${autoAmount === '73,000' ? '✅' : '❌'} 2 張 × 36.5 自動算出金額：${autoAmount}`);
  console.log(`  ${autoCash === '73,000' ? '✅' : '❌'} 帳戶實扣自動帶入：${autoCash}`);
  console.log(`  ${lotHint.includes('2,000 股') ? '✅' : '❌'} 張數換算提示：${lotHint}`);
  if (autoAmount !== '73,000') problems.push(`ETF 金額自動計算錯誤：${autoAmount}`);
  if (autoCash !== '73,000') problems.push(`帳戶實扣自動帶入錯誤：${autoCash}`);

  // 真的存一筆進去，確認會出現在最近紀錄
  await page.fill('#t-fee', '104');
  await page.waitForTimeout(150);
  const cashWithFee = await page.inputValue('#t-cash');
  console.log(`  ${cashWithFee === '73,104' ? '✅' : '❌'} 填手續費後實扣跟著變：${cashWithFee}`);
  if (cashWithFee !== '73,104') problems.push(`手續費未計入帳戶實扣：${cashWithFee}`);

  await page.locator('#trade-form button[type="submit"]').click();
  await page.waitForTimeout(500);
  await shot(page, '04-存完回記錄');

  console.log('\n── 基金買進表單（欄位順序照對帳單）──');
  await page.locator('.picker__btn[data-category="基金"]').click();
  await page.waitForTimeout(200);
  await page.locator('.action[data-action="buy"]').click();
  await page.waitForTimeout(400);
  await page.selectOption('#t-instrument', 'i3');
  await page.waitForTimeout(200);

  const quickVisible = await page.locator('#t-amount-quick').isVisible();
  const quickBtns = await page.locator('#t-amount-quick .quick__btn').allInnerTexts();
  console.log(`  ${quickVisible ? '✅' : '❌'} 申購金額有常用快捷：${quickBtns.join('、')}`);
  if (!quickVisible) problems.push('基金申購沒有出現常用金額快捷');

  await page.locator('#t-amount-quick .quick__btn').first().click();
  await page.waitForTimeout(200);
  const quickFilled = await page.inputValue('#t-amount');
  console.log(`  ${quickFilled === '5,000' ? '✅' : '❌'} 點了快捷後填入：${quickFilled}`);
  if (quickFilled !== '5,000') problems.push(`快捷金額填入錯誤：${quickFilled}`);

  await page.fill('#t-amount', '5000');
  await page.fill('#t-price', '44.8');
  await page.fill('#t-fee', '25');
  await page.waitForTimeout(200);
  const autoUnits = await page.inputValue('#t-qty');
  const fundCash = await page.inputValue('#t-cash');
  console.log(`  ${autoUnits === '111.6071' ? '✅' : '❌'} 5000 ÷ 44.8 自動算出單位數：${autoUnits}`);
  console.log(`  ${fundCash === '5,025' ? '✅' : '❌'} 帳戶實扣＝金額＋手續費：${fundCash}`);
  if (autoUnits !== '111.6071') problems.push(`基金單位數自動計算錯誤：${autoUnits}`);
  if (fundCash !== '5,025') problems.push(`基金帳戶實扣錯誤：${fundCash}`);
  await shot(page, '05-基金買進');

  await page.locator('#trade-sheet [data-close]').click();
  await page.waitForTimeout(400);

  console.log('\n── 配息表單 ──');
  await page.locator('.action[data-action="dividend"]').click();
  await page.waitForTimeout(400);
  await page.selectOption('#d-instrument', 'i3');
  await page.fill('#d-exdate', '2026-09-15');
  await page.waitForTimeout(200);

  // 預設是定期定額，帶入的要是那個部位的單位數（472.7617），不是整檔的 1,272.7617
  const autoHeld = await page.inputValue('#d-units');
  console.log(`  ${autoHeld === '472.7617' ? '✅' : '❌'} 定期定額的持有單位：${autoHeld}`);
  if (autoHeld !== '472.7617') problems.push(`配息帶入的定期定額單位數錯誤：${autoHeld}`);

  await page.locator('#d-style-chips .chip[data-dstyle="單筆"]').click();
  await page.waitForTimeout(250);
  const heldLump = await page.inputValue('#d-units');
  console.log(`  ${heldLump === '800' ? '✅' : '❌'} 切到單筆後跟著換成該部位：${heldLump}`);
  if (heldLump !== '800') problems.push(`切換型態後單位數沒跟著換：${heldLump}`);

  await page.locator('#d-style-chips .chip[data-dstyle="小額"]').click();
  await page.waitForTimeout(250);

  await page.fill('#d-perunit', '0.33');
  await page.fill('#d-received', '255');
  await page.waitForTimeout(200);
  const taxHint = await textOf(page, 'd-tax-hint');
  console.log(`  ${taxHint.includes('應發') ? '✅' : '❌'} 應發／稅費提示：${taxHint}`);
  await shot(page, '06-配息');

  await page.locator('#dividend-sheet [data-close]').click();
  await page.waitForTimeout(400);

  console.log('\n── 入金出金 ──');
  await page.locator('.action[data-action="cash"]').click();
  await page.waitForTimeout(400);
  await shot(page, '07-入金出金');
  await page.locator('#cash-sheet [data-close]').click();
  await page.waitForTimeout(400);

  // 前面存了一筆 0056 進去，會影響持股與餘額，所以清回原始資料再驗算
  await page.evaluate((seed) => {
    for (const [entity, rows] of Object.entries(seed)) {
      localStorage.setItem('pb.' + entity, JSON.stringify(rows.map((r) => ({ ...r, _synced: true }))));
    }
  }, SEED);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(300);

  console.log('\n── 報表頁 ──');
  await page.locator('.tab[data-page="report"]').click();
  await page.waitForTimeout(300);
  await shot(page, '08-報表');
  await check(page, 'rp-total', EXPECT['rp-total'], '全年累積配息');
  await check(page, 'rp-etf', EXPECT['rp-etf'], 'ETF 配息');
  await check(page, 'rp-fund', EXPECT['rp-fund'], '基金配息');
  await check(page, 'bal-etf', EXPECT['bal-etf'], '券商餘額');
  await check(page, 'bal-fund', EXPECT['bal-fund'], '基金帳戶餘額');

  console.log('\n── 持股頁 ──');
  await page.locator('.tab[data-page="holdings"]').click();
  await page.waitForTimeout(300);
  await shot(page, '09-持股');
  await check(page, 'hd-value', EXPECT['hd-value'], '總市值');
  await check(page, 'hd-cost', EXPECT['hd-cost'], '總成本');
  await check(page, 'hd-pl', EXPECT['hd-pl'], '未實現損益');

  await check(page, 'rp-real', EXPECT['rp-real'], '已實現損益');

  const firstHold = (await page.locator('.hold').first().innerText()).replace(/\s+/g, ' ');
  console.log(`  0056 卡片：${firstHold}`);
  const estimateNote = await page.locator('.hold__note').allInnerTexts();
  const hasEstimate = estimateNote.some((t) => t.includes('概估'));
  console.log(`  ${hasEstimate ? '✅' : '❌'} 基金卡片標示概估期初`);
  if (!hasEstimate) problems.push('基金持股沒有標示概估期初');

  console.log('\n── 賣光又買回：成本要重新算 ──');
  const cards = await page.locator('.hold').allInnerTexts();
  const card919 = cards.find((t) => t.includes('00919')) || '';
  const flat919 = card919.replace(/\s+/g, ' ');
  console.log(`  00919 卡片：${flat919}`);

  // 混算的話平均成本會是 (23,800+22,900)/2,000 = 23.35
  const rightAvg = flat919.includes('22.9') && !flat919.includes('23.35');
  console.log(`  ${rightAvg ? '✅' : '❌'} 平均成本 22.9（不是把賣掉那批混進來的 23.35）`);
  if (!rightAvg) problems.push(`00919 買回後的平均成本不對：${flat919}`);

  const hasPast = flat919.includes('過去已實現');
  console.log(`  ${hasPast ? '✅' : '❌'} 卡片上標示過去已實現損益`);
  if (!hasPast) problems.push('買回的部位沒有標示過去已實現損益');

  console.log('\n── 基金分單筆／定期定額 ──');
  const cardFund = cards.find((t) => t.includes('安聯')) || '';
  const flatFund = cardFund.replace(/\s+/g, ' ');
  console.log(`  安聯卡片：${flatFund}`);
  const hasLots = flatFund.includes('定期定額') && flatFund.includes('單筆');
  const hasBothAvg = flatFund.includes('37.5') && flatFund.includes('42.3046');
  console.log(`  ${hasLots ? '✅' : '❌'} 兩段都列出來`);
  console.log(`  ${hasBothAvg ? '✅' : '❌'} 兩段各自的平均成本（37.5、42.3046）`);
  if (!hasLots) problems.push('基金卡片沒有分開列單筆與定期定額');
  if (!hasBothAvg) problems.push('基金兩段的平均成本沒有分開算');

  console.log('\n── 已出清 ──');
  const closedVisible = await page.locator('#closed-section').isVisible();
  console.log(`  ${closedVisible ? '✅' : '❌'} 出現「已出清」區塊`);
  if (!closedVisible) problems.push('沒有出現已出清區塊');

  const closedTitle = await textOf(page, 'closed-title');
  console.log(`  標題：${closedTitle}`);

  await page.locator('#btn-closed-toggle').click();
  await page.waitForTimeout(300);
  const closedItem = (await page.locator('.closed__item').first().innerText()).replace(/\s+/g, ' ');
  console.log(`  展開後：${closedItem}`);

  const closedOk = closedItem.includes('00919')
    && closedItem.includes('+$2,601')
    && closedItem.includes('713');   // 期間配息歸到這一段
  console.log(`  ${closedOk ? '✅' : '❌'} 已出清那段顯示已實現 +$2,601、期間配息 $713`);
  if (!closedOk) problems.push(`已出清內容不對：${closedItem}`);
  await shot(page, '09b-已出清');

  console.log('\n── 更新現價 ──');
  await page.locator('.hold__price-btn').first().click();
  await page.waitForTimeout(400);
  await shot(page, '10-更新現價');
  await page.locator('#price-sheet [data-close]').click();
  await page.waitForTimeout(400);

  console.log('\n── 設定頁 ──');
  await page.locator('#btn-settings').click();
  await page.waitForTimeout(300);
  await shot(page, '11-設定');

  console.log('\n── 深色 ──');
  await page.locator('#theme-chips .chip[data-theme-pref="dark"]').click();
  await page.waitForTimeout(300);
  await shot(page, '12-設定-深色');

  await page.locator('.tab[data-page="record"]').click();
  await page.waitForTimeout(300);
  await shot(page, '13-記錄-深色');

  await page.locator('.tab[data-page="report"]').click();
  await page.waitForTimeout(300);
  await shot(page, '14-報表-深色');

  await page.locator('.tab[data-page="holdings"]').click();
  await page.waitForTimeout(300);
  await shot(page, '15-持股-深色');

  /* ---------- 自動抓現價 ----------
     用假的後端把整條路走一遍：抓報價 → 寫進本機 → 同步上去 → 再拉回來。
     最後這步是重點：如果同步把伺服器的舊價蓋回本機，剛抓的價就白抓了。 */
  console.log('\n── 自動抓 ETF 現價（mock 後端）──');

  const MOCK_QUOTES = {
    '0056': { price: 55.75, name: '元大高股息', live: false, time: '09:00:05', source: '前一交易日收盤' },
    '00919': { price: 32.71, name: '群益台灣精選高息', live: false, time: '09:00:00', source: '前一交易日收盤' },
  };

  // 假後端自己記著資料，save 進來就更新，list 出去是更新後的版本
  const serverState = JSON.parse(JSON.stringify(SEED));

  await page.route('https://mock.local/exec', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    const json = (obj) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(obj),
    });

    if (body.action === 'quotes') return json({ ok: true, quotes: MOCK_QUOTES });

    if (body.action === 'save') {
      const list = serverState[body.entity] || (serverState[body.entity] = []);
      const i = list.findIndex((r) => r.id === body.record.id);
      if (i === -1) list.push({ ...body.record }); else list[i] = { ...list[i], ...body.record };
      return json({ ok: true, entity: body.entity, record: body.record });
    }

    if (body.action === 'remove') {
      serverState[body.entity] = (serverState[body.entity] || []).filter((r) => r.id !== body.id);
      return json({ ok: true, entity: body.entity, id: body.id });
    }

    return json({ ok: true, ...serverState });
  });

  await page.evaluate((seed) => {
    for (const [entity, rows] of Object.entries(seed)) {
      localStorage.setItem('pb.' + entity, JSON.stringify(rows.map((r) => ({ ...r, _synced: true }))));
    }
    localStorage.setItem('pb.apiUrl', 'https://mock.local/exec');
    localStorage.setItem('pb.secret', 'test');
    localStorage.setItem('pb.theme', 'light');
  }, SEED);

  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.tab[data-page="holdings"]').click();
  await page.waitForTimeout(400);

  const barVisible = await page.locator('#quote-bar').isVisible();
  console.log(`  ${barVisible ? '✅' : '❌'} 持股頁出現「更新 ETF 現價」按鈕`);
  if (!barVisible) problems.push('持股頁沒有出現更新現價按鈕');

  await page.locator('#btn-refresh-prices').click();
  await page.waitForTimeout(900);
  await shot(page, '16-抓現價');

  // 0056 抓到 55.75 → 3,000 股市值 167,250；00919 32.71 → 32,710
  // 基金維持手動的 46.2 → 58,801.6，合計 258,762
  await check(page, 'hd-value', '$258,762', '抓價後總市值');

  const holdText = (await page.locator('.hold').first().innerText()).replace(/\s+/g, ' ');
  console.log(`  0056 卡片：${holdText}`);
  const gotPrice = holdText.includes('55.75');
  console.log(`  ${gotPrice ? '✅' : '❌'} 0056 現價更新為 55.75`);
  if (!gotPrice) problems.push('0056 現價沒有更新成抓到的報價');

  // 同步一輪之後再看一次，確認沒有被伺服器的舊值蓋回去
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(900);
  const stillThere = (await page.locator('.hold').first().innerText()).includes('55.75');
  console.log(`  ${stillThere ? '✅' : '❌'} 同步一輪後現價沒有被蓋回舊值`);
  if (!stillThere) problems.push('同步後現價被伺服器舊值蓋掉');

  console.log('\n── 單檔自動抓取 ──');
  await page.locator('.hold__price-btn').first().click();
  await page.waitForTimeout(400);
  const fetchBtnVisible = await page.locator('#btn-fetch-price').isVisible();
  console.log(`  ${fetchBtnVisible ? '✅' : '❌'} ETF 的現價表單有「自動抓取」按鈕`);
  if (!fetchBtnVisible) problems.push('現價表單沒有自動抓取按鈕');

  await page.fill('#p-price', '1');
  await page.locator('#btn-fetch-price').click();
  await page.waitForTimeout(700);
  const fetched = await page.inputValue('#p-price');
  console.log(`  ${fetched === '55.75' ? '✅' : '❌'} 抓取後填入價格：${fetched}`);
  if (fetched !== '55.75') problems.push(`單檔抓取填入的價格不對：${fetched}`);
  await shot(page, '17-單檔抓取');

  await browser.close();

  console.log('\n' + '─'.repeat(46));
  if (errors.length) {
    console.log(`\n❌ JS 錯誤 ${errors.length} 個：`);
    errors.forEach((e) => console.log('   ' + e));
  } else {
    console.log('\n✅ 沒有 JS 錯誤');
  }

  if (problems.length) {
    console.log(`\n❌ 數字對不上 ${problems.length} 處：`);
    problems.forEach((p) => console.log('   ' + p));
    process.exitCode = 1;
  } else {
    console.log('✅ 所有數字都對得上');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
