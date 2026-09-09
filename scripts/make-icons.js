/**
 * 產生 PWA 圖示（不依賴任何套件，純 Node 手寫 PNG）
 * 執行：node scripts/make-icons.js
 *
 * 圖案：琥珀金底 + 白色小豬撲滿，背上有投幣口。
 * 內容都落在中心安全區內，所以可以當 maskable icon 用。
 */

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const BG = [0xc9, 0x8f, 0x18]; // 琥珀金的深化版，與 App 的 --accent-deep 同一支
const FG = [0xff, 0xff, 0xff]; // 撲滿白

/* ---------- PNG 編碼 ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** pixels: Buffer，size*size*4 的 RGBA */
function encodePng(size, pixels) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // 每條掃描線前面加一個 filter byte（0 = None）
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- 圖形基本款 ----------
   座標一律用畫布比例（0～1）寫，乘上 S 之後任何尺寸都畫得出同一個圖案。 */

function inEllipse(px, py, cx, cy, rx, ry, S) {
  const dx = (px - cx * S) / (rx * S);
  const dy = (py - cy * S) / (ry * S);
  return dx * dx + dy * dy <= 1;
}

function inRoundRect(px, py, x0, y0, x1, y1, r, S) {
  const cx = Math.min(Math.max(px, x0 * S + r * S), x1 * S - r * S);
  const cy = Math.min(Math.max(py, y0 * S + r * S), y1 * S - r * S);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= (r * S) * (r * S);
}

/** 三角形：三次叉積同號就在裡面 */
function inTriangle(px, py, pts, S) {
  const sign = (ax, ay, bx, by, cx, cy) =>
    (ax - cx) * (by - cy) - (bx - cx) * (ay - cy);

  const [a, b, c] = pts.map((p) => [p[0] * S, p[1] * S]);
  const d1 = sign(px, py, a[0], a[1], b[0], b[1]);
  const d2 = sign(px, py, b[0], b[1], c[0], c[1]);
  const d3 = sign(px, py, c[0], c[1], a[0], a[1]);

  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/* ---------- 小豬 ---------- */

/** 身體、耳朵、鼻子、四條腿，接在一起就是一隻豬 */
function isPig(px, py, S) {
  if (inEllipse(px, py, 0.48, 0.55, 0.31, 0.225, S)) return true;      // 身體
  if (inEllipse(px, py, 0.795, 0.585, 0.088, 0.078, S)) return true;   // 鼻子
  if (inTriangle(px, py, [[0.585, 0.375], [0.715, 0.295], [0.700, 0.430]], S)) return true; // 耳朵
  if (inRoundRect(px, py, 0.285, 0.715, 0.395, 0.805, 0.022, S)) return true; // 前腿
  if (inRoundRect(px, py, 0.545, 0.715, 0.655, 0.805, 0.022, S)) return true; // 後腿
  return false;
}

/** 挖空的部分：背上的投幣口、眼睛、鼻孔 */
function isCutout(px, py, S) {
  if (inRoundRect(px, py, 0.375, 0.395, 0.560, 0.437, 0.021, S)) return true; // 投幣口
  if (inEllipse(px, py, 0.655, 0.505, 0.030, 0.032, S)) return true;          // 眼睛
  if (inEllipse(px, py, 0.775, 0.578, 0.017, 0.021, S)) return true;          // 鼻孔
  if (inEllipse(px, py, 0.822, 0.592, 0.017, 0.021, S)) return true;
  return false;
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const SS = 3; // 每軸 3x 超取樣，邊緣才不會鋸齒

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      const total = SS * SS;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (isPig(px, py, size) && !isCutout(px, py, size)) hits++;
        }
      }

      const t = hits / total; // 0 = 純背景，1 = 純撲滿
      const i = (y * size + x) * 4;
      pixels[i]     = Math.round(BG[0] + (FG[0] - BG[0]) * t);
      pixels[i + 1] = Math.round(BG[1] + (FG[1] - BG[1]) * t);
      pixels[i + 2] = Math.round(BG[2] + (FG[2] - BG[2]) * t);
      pixels[i + 3] = 255;
    }
  }
  return pixels;
}

/* ---------- 輸出 ---------- */

const outDir = path.join(__dirname, '..', 'www', 'icons');
fs.mkdirSync(outDir, { recursive: true });

for (const size of [180, 192, 512]) {
  const file = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(file, encodePng(size, render(size)));
  console.log(`已產生 ${path.relative(process.cwd(), file)}  (${size}x${size})`);
}
