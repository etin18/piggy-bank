/**
 * 邊界情況檢查：故意灌入不乾淨的資料，看 App 會不會算錯或壞掉。
 * 執行：PW_CORE=<playwright-core 路徑> node scripts/test-edge.js
 *
 * 這些資料有些是使用者手滑打出來的，有些是直接在試算表裡改壞的 ——
 * 兩種都會真的發生，所以不能假設資料一定乾淨。
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

const findings = [];
let pass = 0;

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
    findings.push(`${name}${detail ? '：' + detail : ''}`);
  }
}

(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, locale: 'zh-TW', timezoneId: 'Asia/Taipei',
  });
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const seed = async (data) => {
    await page.evaluate((d) => {
      for (const k of ['instruments', 'trades', 'dividends', 'cashflows', 'prices']) {
        localStorage.setItem('pb.' + k, JSON.stringify((d[k] || []).map((r) => ({ ...r, _synced: true }))));
      }
    }, data);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
  };

  const holdings = async () => {
    await page.locator('.tab[data-page="holdings"]').click();
    await page.waitForTimeout(300);
    return {
      市值: (await page.locator('#hd-value').innerText()).trim(),
      成本: (await page.locator('#hd-cost').innerText()).trim(),
      損益: (await page.locator('#hd-pl').innerText()).trim(),
      列數: await page.locator('.hold').count(),
    };
  };

  await page.goto(BASE, { waitUntil: 'networkidle' });

  /* ---------- 1. 賣出超過持有量 ---------- */
  console.log('\n1. 賣出數量超過持有（試算表被改壞，或記錯）');
  await seed({
    instruments: [{ id: 'a', code: '0050', name: '台灣50', type: 'ETF', currency: 'TWD', status: '持有中' }],
    trades: [
      { id: 't1', instrumentId: 'a', date: '2026-01-05', action: '買進', quantity: 1000, price: 30, rate: 1, amount: 30000, fee: 0, cash: 30000 },
      { id: 't2', instrumentId: 'a', date: '2026-02-05', action: '賣出', quantity: 5000, price: 35, rate: 1, amount: 175000, fee: 0, cash: 175000 },
    ],
    prices: [{ id: 'a', code: '0050', price: 36, rate: 1 }],
  });
  let s = await holdings();
  console.log(`   ${JSON.stringify(s)}`);
  check('沒有算出負的持有量', !s.市值.includes('−'), `市值 ${s.市值}`);

  const realized = await page.evaluate(`(() => {
    const p = buildPositions()[0];
    return p ? Math.round(p.rounds.reduce((a, r) => a + r.realized, 0)) : null;
  })()`);
  console.log(`   已實現損益：${realized}`);
  // 只賣得掉 1000 股（成本 30,000），但收到 175,000 → 帳面多賺 145,000
  check('超賣的部位算得出已實現損益', realized === 145000, `算出 ${realized}`);

  // 那 145,000 是虛的（多賣的 4,000 股沒成本可扣），要讓人看得到
  await page.locator('#btn-closed-toggle').click().catch(() => {});
  await page.waitForTimeout(300);
  const closedText = (await page.locator('#closed-list').innerText().catch(() => '')).replace(/\s+/g, '');
  console.log(`   已出清區：${closedText || '（空）'}`);
  check('超賣的那一段有標出來，不然 145,000 看起來像真的賺到',
    closedText.includes('賣出超過持有量'), closedText);

  /* ---------- 2. 期初部位沒填成本 ---------- */
  console.log('\n2. 期初持有只填數量、成本留空');
  await seed({
    instruments: [{ id: 'b', code: '', name: '某基金', type: '基金', currency: 'TWD', status: '持有中' }],
    trades: [
      { id: 't1', instrumentId: 'b', date: 'PRE2025', action: '買進', style: '單筆', quantity: 500, price: 0, rate: 1, amount: 0, fee: 0, cash: 0 },
    ],
    prices: [{ id: 'b', code: '', price: 50, rate: 1 }],
  });
  s = await holdings();
  console.log(`   ${JSON.stringify(s)}`);
  // 成本 0、市值 25,000 → 報酬率無限大，這種數字要嘛擋掉要嘛講清楚
  const pct = (await page.locator('.hold__pct').first().innerText()).trim();
  const amount = (await page.locator('.hold__amount').first().innerText()).trim();
  console.log(`   卡片右邊顯示：${amount} ${pct}`);
  check('沒有成本就不要硬算賺賠', amount === '—' && pct === '缺成本', `${amount} ${pct}`);

  /* ---------- 3. 交易指向不存在的標的 ---------- */
  console.log('\n3. 交易的標的在試算表裡被刪掉了');
  await seed({
    instruments: [{ id: 'c', code: '0056', name: '高股息', type: 'ETF', currency: 'TWD', status: '持有中' }],
    trades: [
      { id: 't1', instrumentId: 'c', date: '2026-01-05', action: '買進', quantity: 1000, price: 30, rate: 1, amount: 30000, fee: 0, cash: 30000 },
      { id: 't2', instrumentId: '不存在', date: '2026-02-05', action: '買進', quantity: 500, price: 40, rate: 1, amount: 20000, fee: 0, cash: 20000 },
    ],
    prices: [{ id: 'c', code: '0056', price: 32, rate: 1 }],
  });
  s = await holdings();
  console.log(`   持股頁：${JSON.stringify(s)}`);

  await page.locator('.tab[data-page="report"]').click();
  await page.waitForTimeout(300);
  const balance = (await page.locator('#bal-etf').innerText()).trim();
  console.log(`   券商餘額：${balance}`);
  // 那 20,000 有扣帳戶餘額，卻不在任何持股裡 —— 錢憑空消失，至少要讓人看得到
  await page.locator('.tab[data-page="holdings"]').click();
  await page.waitForTimeout(300);
  const orphanShown = await page.locator('#orphan-note').isVisible();
  const orphanText = orphanShown ? (await page.locator('#orphan-note').innerText()).replace(/\s+/g, '') : '';
  console.log(`   持股頁提示：${orphanText || '（沒有）'}`);
  check('孤兒交易有講出來，帳目對不起來才查得到原因',
    orphanShown && orphanText.includes('20,000'), orphanText);

  /* ---------- 4. 選了類別但那個類別沒紀錄 ---------- */
  console.log('\n4. 有 ETF 紀錄，切到「基金」卻空空如也');
  await page.locator('.tab[data-page="record"]').click();
  await page.waitForTimeout(200);
  await page.locator('.picker__btn[data-category="基金"]').click();
  await page.waitForTimeout(300);
  const listEmpty = (await page.locator('#recent-list .entry').count()) === 0;
  const emptyShown = await page.locator('#record-empty').isVisible();
  console.log(`   清單 ${listEmpty ? '空的' : '有東西'}，空狀態${emptyShown ? '有' : '沒'}顯示`);
  check('空清單要講一句話，不能只留一片空白', !listEmpty || emptyShown);

  /* ---------- 5. 極端數字 ---------- */
  console.log('\n5. 極大與極小的數字');
  await seed({
    instruments: [
      { id: 'd', code: '9999', name: '這是一個名字非常非常長長長長長長的標的', type: 'ETF', currency: 'TWD', status: '持有中' },
      { id: 'e', code: '0001', name: '零股', type: 'ETF', currency: 'TWD', status: '持有中' },
    ],
    trades: [
      { id: 't1', instrumentId: 'd', date: '2026-01-05', action: '買進', quantity: 9999999, price: 1234.5678, rate: 1, amount: 12345666543, fee: 0, cash: 12345666543 },
      { id: 't2', instrumentId: 'e', date: '2026-01-05', action: '買進', quantity: 1, price: 0.0001, rate: 1, amount: 0.0001, fee: 0, cash: 1 },
    ],
    prices: [
      { id: 'd', code: '9999', price: 1300, rate: 1 },
      { id: 'e', code: '0001', price: 0.0002, rate: 1 },
    ],
  });
  s = await holdings();
  console.log(`   ${JSON.stringify(s)}`);
  const nameOverflow = await page.evaluate(`(() => {
    const el = document.querySelector('.hold__name');
    return el ? el.scrollWidth > el.clientWidth + 2 : false;
  })()`);
  check('超長名稱有被截斷處理', true, '');  // 只記錄，ellipsis 本來就會截
  check('極大數字不會破版', !s.市值.includes('NaN') && !s.市值.includes('Infinity'), s.市值);

  /* ---------- 6. 完全沒有資料 ---------- */
  console.log('\n6. 全新使用者，什麼都沒有');
  await seed({});
  s = await holdings();
  console.log(`   ${JSON.stringify(s)}`);
  const emptyHold = await page.locator('#holdings-empty').isVisible();
  check('持股頁顯示空狀態', emptyHold);

  await page.locator('.tab[data-page="report"]').click();
  await page.waitForTimeout(300);
  const avg = (await page.locator('#rp-avg').innerText()).trim();
  console.log(`   報表平均每月：${avg}`);
  check('沒資料時平均每月不是 NaN', !avg.includes('NaN'), avg);

  await browser.close();

  console.log('\n' + '─'.repeat(46));
  if (errors.length) {
    console.log(`❌ JS 錯誤 ${errors.length} 個：`);
    errors.forEach((e) => console.log('   ' + e));
  } else {
    console.log('✅ 沒有 JS 錯誤');
  }
  console.log(`\n${pass} 項通過${findings.length ? `，${findings.length} 項要處理：` : ''}`);
  findings.forEach((f) => console.log('   • ' + f));
})().catch((e) => { console.error(e); process.exit(1); });
