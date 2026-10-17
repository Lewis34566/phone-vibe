'use strict';
// 生成 PWA 图标（纯 Node，无依赖）：圆角渐变底 + 白色 ">_" 光标
// 运行：node scripts/gen-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crc32 = require('../src/crc32');

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function png(size, pixel) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      const o = y * stride + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 圆角矩形 SDF 判定
function inRoundedRect(u, v, rad) {
  const x = Math.max(rad - u, u - (1 - rad), 0);
  const y = Math.max(rad - v, v - (1 - rad), 0);
  return Math.hypot(x, y) <= rad;
}

// 点到线段距离（画 > 折线）
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function iconPixel(x, y, size) {
  const u = x / size, v = y / size;
  if (!inRoundedRect(u, v, 0.22)) return [0, 0, 0, 0];
  // 渐变 #6d6cf0 -> #8b5cf6
  const r = Math.round(0x6d + (0x8b - 0x6d) * v);
  const g = Math.round(0x6c + (0x5c - 0x6c) * v);
  const b = Math.round(0xf0 + (0xf6 - 0xf0) * v);
  // 白色 ">_" 光标
  const th = 0.055;
  const d = Math.min(
    segDist(u, v, 0.30, 0.36, 0.50, 0.50),
    segDist(u, v, 0.50, 0.50, 0.30, 0.64),
    segDist(u, v, 0.34, 0.72, 0.58, 0.74)
  );
  if (d < th) return [255, 255, 255, 255];
  return [r, g, b, 255];
}

// 图标缺失时生成（server.js 启动时也会调用，手机上第一次启动自动生成）
function ensureIcons() {
  const outDir = path.join(__dirname, '..', 'public', 'icons');
  const missing = [192, 512].some((s) => !fs.existsSync(path.join(outDir, `icon-${s}.png`)));
  if (!missing) return;
  fs.mkdirSync(outDir, { recursive: true });
  for (const s of [192, 512]) {
    fs.writeFileSync(path.join(outDir, `icon-${s}.png`), png(s, iconPixel));
  }
  console.log('  PWA 图标已生成到 public/icons/');
}

if (require.main === module) {
  ensureIcons();
  console.log('done');
}

module.exports = { ensureIcons };
