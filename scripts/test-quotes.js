/**
 * 驗證台股報價的抓取與解析邏輯：node scripts/test-quotes.js [代號…]
 *
 * Code.gs 裡的 fetchQuotes 要部署到 Apps Script 才跑得起來，
 * 但解析錯了在那邊很難查。這支用 Node 跑同一套解析，
 * 先確認欄位名稱和取價順序是對的。
 *
 * 兩邊的邏輯要一起改 —— 這裡改了，Code.gs 也要改。
 */

const https = require('https');

const CODES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['0056', '00919', '006208', '00929', '00687B'];

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers, timeout: 20000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('逾時')); });
  });
}

/* ---------- 以下三個函式與 Code.gs 同一套邏輯 ---------- */

function firstPrice(values) {
  for (const v of values) {
    const n = Number(String(v === null || v === undefined ? '' : v).replace(/,/g, ''));
    if (isFinite(n) && n > 0) return n;
  }
  return 0;
}

async function fetchFromMis(codes, result) {
  for (let start = 0; start < codes.length; start += 20) {
    const batch = codes.slice(start, start + 20);
    const channels = [];
    for (const code of batch) {
      channels.push(`tse_${code}.tw`);
      channels.push(`otc_${code}.tw`);
    }

    const url = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?json=1&delay=0&ex_ch='
      + channels.join('|');

    try {
      const data = JSON.parse(await get(url, { Referer: 'https://mis.twse.com.tw/stock/fibest.jsp' }));
      for (const row of data.msgArray || []) {
        const code = String(row.c || '').trim().toUpperCase();
        if (!code || result[code]) continue;

        // 順序不能換：開盤前的 pz 是試搓模擬價，不是真實成交價
        const price = firstPrice([row.z, row.y, row.pz]);
        if (!price) continue;

        const live = firstPrice([row.z]) > 0;
        result[code] = {
          price, name: String(row.n || ''), live,
          time: String(row.t || ''),
          source: live ? '最新成交' : '前一交易日收盤',
        };
      }
    } catch (err) {
      console.log(`  ⚠️  MIS 這批失敗：${err.message}`);
    }
  }
}

async function fetchFromDailyApi(codes, result) {
  if (!codes.length) return;

  const sources = [
    { url: 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
      codeKey: 'Code', priceKey: 'ClosingPrice', nameKey: 'Name', label: '上市收盤' },
    { url: 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes',
      codeKey: 'SecuritiesCompanyCode', priceKey: 'Close', nameKey: 'CompanyName', label: '上櫃收盤' },
  ];

  for (const source of sources) {
    if (!codes.filter((c) => !result[c]).length) return;
    try {
      const rows = JSON.parse(await get(source.url));
      for (const row of rows) {
        const code = String(row[source.codeKey] || '').trim().toUpperCase();
        if (!code || result[code] || !codes.includes(code)) continue;

        const price = firstPrice([row[source.priceKey]]);
        if (!price) continue;

        result[code] = {
          price, name: String(row[source.nameKey] || ''),
          live: false, time: '', source: source.label,
        };
      }
    } catch (err) {
      console.log(`  ⚠️  ${source.label} 失敗：${err.message}`);
    }
  }
}

/* ---------- 跑 ---------- */

(async () => {
  console.log(`查詢：${CODES.join('、')}\n`);

  const result = {};
  console.log('── 證交所 MIS（即時）──');
  await fetchFromMis(CODES, result);
  console.log(`  拿到 ${Object.keys(result).length} 檔\n`);

  const missing = CODES.filter((c) => !result[c]);
  if (missing.length) {
    console.log(`── 每日收盤 OpenAPI（補 ${missing.join('、')}）──`);
    await fetchFromDailyApi(missing, result);
    console.log('');
  }

  console.log('── 結果 ──');
  let ok = 0;
  for (const code of CODES) {
    const q = result[code];
    if (q) {
      ok++;
      console.log(`  ✅ ${code.padEnd(7)} ${String(q.price).padStart(8)}  ${q.source}${q.time ? ' · ' + q.time : ''}  ${q.name}`);
    } else {
      console.log(`  ❌ ${code.padEnd(7)} 查不到`);
    }
  }
  console.log(`\n${ok}/${CODES.length} 檔查到報價`);
  if (ok < CODES.length) process.exitCode = 1;
})();
