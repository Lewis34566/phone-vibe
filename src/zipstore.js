'use strict';
// 零依赖 ZIP 生成器（store 模式：不压缩但所有解压软件都能打开）
// 用于"一键导出项目 zip"，省去在 Termux 里装 zip 命令
const crc32 = require('./crc32');

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xffff); return b; }
function u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; }

// entries: [{ name, data: Buffer, mtime: Date }]
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = e.data;
    const crc = crc32(data);
    const { time, date } = dosDateTime(e.mtime ? new Date(e.mtime) : new Date());
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), // 0x0800 = UTF-8 文件名
      u16(0), u16(time), u16(date),
      u32(crc), u32(data.length), u32(data.length),
      u16(nameBuf.length), u16(0),
      nameBuf,
    ]);
    chunks.push(local, data);
    central.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0),
      u16(time), u16(date), u32(crc), u32(data.length), u32(data.length),
      u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(offset),
      nameBuf,
    ]));
    offset += local.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0),
    u16(entries.length), u16(entries.length),
    u32(centralBuf.length), u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

module.exports = { buildZip };
