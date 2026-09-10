/**
 * 底部面板「往下拉關閉」手勢測試。
 * 執行：PW_CORE=<playwright-core 路徑> node scripts/test-sheet-drag.js
 *
 * 用 CDP 送真的觸控事件（不是 JS 合成的 TouchEvent），
 * 這樣 touch-action、preventDefault 擋不擋得住捲動才測得準。
 *
 * 最容易寫壞的是 F：接管手勢時把內容捲動也一起搶走，
 * 使用者想往下看表單後半段，結果面板被拉掉。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { chromium } = require(process.env.PW_CORE);

const BASE = 'http://localhost:8789';

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

let pass = 0;
let fail = 0;

function check(name, ok, extra = '') {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

const SEED = {
  instruments: [
    { id: 'i1', code: '0056', name: '元大高股息', type: 'ETF', currency: 'TWD',
      frequency: '季配', status: '持有中', note: '', _synced: true },
  ],
};

(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  /**
   * 從 (x,y) 往下拖 dist，分 steps 步。
   * CDP 每送一次事件本身就有往返延遲，所以「一步拉多遠」等於在調速度：
   * 步數少＝每步位移大＝甩得快。hold 是放手前停住不動的時間。
   */
  async function dragDown(x, y, dist, { steps = 8, pause = 16, release = true, hold = 0 } = {}) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: [{ x, y: y + (dist * i) / steps }],
      });
      if (pause) await page.waitForTimeout(pause);
    }
    if (hold) await page.waitForTimeout(hold);
    if (release) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
  }

  const openTradeSheet = async () => {
    // 上一段沒關成功的話先收掉，不然點不到底下的按鈕，錯誤會連環爆
    if (await page.isVisible('#trade-sheet')) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    }
    await page.click('.tab[data-page="record"]');
    await page.waitForTimeout(150);
    if (!(await page.isVisible('#actions'))) {
      await page.click('.picker__btn[data-category="ETF"]');
      await page.waitForTimeout(200);
    }
    await page.click('.action[data-action="buy"]');
    await page.waitForTimeout(450);
  };

  const sheetState = () => page.evaluate(`(() => {
    const s = document.getElementById('trade-sheet');
    return {
      開著: !s.hidden && s.classList.contains('is-open'),
      位移: s.style.transform || '（無）',
      遮罩透明度: document.getElementById('scrim').style.opacity || '（無）',
    };
  })()`);

  const bodyTop = () => page.evaluate(
    `document.querySelector('#trade-sheet .sheet__body').scrollTop`
  );
  const setBodyTop = (v) => page.evaluate(
    `document.querySelector('#trade-sheet .sheet__body').scrollTop = ${v}`
  );

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate((seed) => {
    for (const [entity, rows] of Object.entries(seed)) {
      localStorage.setItem('pb.' + entity, JSON.stringify(rows));
    }
  }, SEED);
  await page.reload({ waitUntil: 'networkidle' });

  // 直接數 touchmove 有沒有被 preventDefault：
  // 接管手勢時要攔下捲動，讓路給捲動時就不能攔。
  // 比檢查 scrollTop 準 —— CDP 合成的觸控不一定會真的觸發瀏覽器捲動
  await page.evaluate(() => {
    window.__prevented = 0;
    document.addEventListener('touchmove', (e) => {
      if (e.defaultPrevented) window.__prevented++;
    });
  });
  const preventedCount = () => page.evaluate('window.__prevented');
  const resetPrevented = () => page.evaluate('window.__prevented = 0');

  const gripAt = async () => {
    const box = await page.locator('#trade-sheet .sheet__grip').boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };

  /* ---------- 拉夠遠 ---------- */
  console.log('\nA. 從握把往下拉 220px');
  await openTradeSheet();
  check('面板有開起來', (await sheetState()).開著);
  let g = await gripAt();
  await dragDown(g.x, g.y, 220);
  await page.waitForTimeout(120);
  const midClose = await sheetState();
  check('放手後開始關閉', !midClose.開著, JSON.stringify(midClose));
  await page.waitForTimeout(350);
  check('關完後面板收起來', await page.isHidden('#trade-sheet'));
  check('遮罩也收了', await page.isHidden('#scrim'));
  check('inline 位移有清乾淨（不然下次開會歪掉）',
    (await sheetState()).位移 === '（無）', (await sheetState()).位移);

  /* ---------- 再開一次，確認沒有殘留 ---------- */
  console.log('\nB. 關掉後再開');
  await openTradeSheet();
  const reopened = await sheetState();
  check('正常開起來、沒有殘留位移',
    reopened.開著 && reopened.位移 === '（無）', JSON.stringify(reopened));

  /* ---------- 拉一點點就放手 ---------- */
  console.log('\nC. 只拉 40px（拉不夠遠）');
  g = await gripAt();
  await dragDown(g.x, g.y, 40, { steps: 6, pause: 40 });   // 慢慢拉，避免被判定成甩
  await page.waitForTimeout(400);
  const bounced = await sheetState();
  check('沒有關掉，彈回原位', bounced.開著, JSON.stringify(bounced));
  check('位移清掉了', bounced.位移 === '（無）', bounced.位移);
  check('遮罩透明度也還原', bounced.遮罩透明度 === '（無）', bounced.遮罩透明度);

  /* ---------- 跟手 ---------- */
  console.log('\nD. 拉到一半還沒放手');
  g = await gripAt();
  await dragDown(g.x, g.y, 90, { steps: 6, pause: 20, release: false });
  const holding = await sheetState();
  const px = parseFloat((holding.位移.match(/([\d.]+)px/) || [])[1] || '0');
  check('面板跟著手指移動', px > 60 && px < 120, holding.位移);
  check('遮罩跟著變淡',
    holding.遮罩透明度 !== '（無）' && parseFloat(holding.遮罩透明度) < 1,
    holding.遮罩透明度);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(400);
  check('放手後彈回（90px 還不到門檻）', (await sheetState()).開著);

  /* ---------- 快速甩 ---------- */
  // 100px 不到 110 的距離門檻，關掉的話就是速度判定生效了
  console.log('\nE. 往下甩 100px（距離不夠，但最後一段夠快）');
  g = await gripAt();
  await dragDown(g.x, g.y, 100, { steps: 2, pause: 0 });
  await page.waitForTimeout(150);
  check('甩得夠快就關掉', !(await sheetState()).開著);
  await page.waitForTimeout(350);

  console.log('\nE2. 一樣拉 100px，但放手前停住不動');
  await openTradeSheet();
  g = await gripAt();
  await dragDown(g.x, g.y, 100, { steps: 2, pause: 0, hold: 300 });
  await page.waitForTimeout(400);
  check('停住再放手不算甩，彈回去', (await sheetState()).開著, JSON.stringify(await sheetState()));

  /* ---------- 內容捲動不該被搶走 ---------- */
  // 把視窗壓矮，逼出捲動條 —— 這是最容易寫壞的一項
  console.log('\nF. 內容捲到中間時往下拉（螢幕壓到 500px 高）');
  await page.setViewportSize({ width: 390, height: 500 });
  await page.waitForTimeout(200);
  await setBodyTop(60);
  await page.waitForTimeout(100);
  const scrolled = await bodyTop();
  check('面板內容確實需要捲動了', scrolled >= 10, `scrollTop=${scrolled}`);

  /* 從表單內容起手（不是握把、也不是輸入框）。
     不能直接抓「第一個 label」的座標 —— 內容捲動之後它已經跑到面板上方，
     觸控點會落在標題列上，那是另一條會接管的路徑。 */
  const spotInBody = () => page.evaluate(() => {
    const body = document.querySelector('#trade-sheet .sheet__body');
    const box = body.getBoundingClientRect();
    for (let y = box.top + 20; y < box.bottom - 20; y += 8) {
      const x = box.left + 12;
      const el = document.elementFromPoint(x, y);
      if (el && el.closest('.sheet__body') && !el.closest('input, textarea, select, button')) {
        return { x, y };
      }
    }
    return null;
  });

  const spot = await spotInBody();
  check('找得到非輸入框的落點', !!spot);
  await resetPrevented();
  await dragDown(spot.x, spot.y, 80, { steps: 6, pause: 16 });
  await page.waitForTimeout(400);
  const afterScroll = await sheetState();
  check('沒有把面板拉掉', afterScroll.開著, JSON.stringify(afterScroll));
  check('那是捲動，不是拖曳', afterScroll.位移 === '（無）', afterScroll.位移);
  const prevented = await preventedCount();
  check('沒有攔下捲動，交給瀏覽器處理', prevented === 0, `preventDefault ${prevented} 次`);

  console.log('\nF2. 捲回最頂之後再往下拉');
  await setBodyTop(0);
  await page.waitForTimeout(100);
  const topBefore = await bodyTop();
  const spotTop = await spotInBody();
  await resetPrevented();
  await dragDown(spotTop.x, spotTop.y, 200, { steps: 6, pause: 16 });
  await page.waitForTimeout(450);
  check('已經在最頂了，這次就關得掉', await page.isHidden('#trade-sheet'),
    `拉之前 scrollTop=${topBefore}，拉完 ${JSON.stringify(await sheetState())}`);
  check('這次有接管，攔下了捲動', (await preventedCount()) > 0);
  await page.setViewportSize({ width: 390, height: 844 });

  /* ---------- 從輸入框起手 ---------- */
  console.log('\nG. 從輸入框往下拉');
  await openTradeSheet();
  await setBodyTop(0);
  await page.waitForTimeout(100);
  const input = await page.locator('#t-qty').boundingBox();
  await dragDown(input.x + input.width / 2, input.y + input.height / 2, 150,
    { steps: 6, pause: 16 });
  await page.waitForTimeout(400);
  check('從輸入框拉不會關掉（要讓人選字）', (await sheetState()).開著);

  await browser.close();

  console.log('\n' + '─'.repeat(46));
  if (errors.length) {
    console.log(`❌ JS 錯誤 ${errors.length} 個：`);
    errors.forEach((e) => console.log('   ' + e));
  }
  console.log(`${fail ? '❌' : '✅'} ${pass} 項通過${fail ? `，${fail} 項失敗` : ''}`);
  if (fail || errors.length) process.exitCode = 1;
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
