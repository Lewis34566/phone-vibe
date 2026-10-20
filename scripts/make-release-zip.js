'use strict';
// 打包整个项目（不含 .git / node_modules / 临时数据），生成可直接发到手机的安装包
// 用法（在项目目录里执行）：
//   node scripts/make-release-zip.js            → 生成到上级目录 手机版Agent-安装包.zip
//   node scripts/make-release-zip.js 输出路径   → 生成到指定路径
const fs = require('fs');
const path = require('path');
const { buildZip } = require('../src/zipstore');

const ROOT = path.join(__dirname, '..');
const out = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(path.dirname(ROOT), '手机版Agent-安装包.zip');

// .env 绝不能进安装包（里面有 API Key）；install.sh 会从 .env.example 生成
const SKIP = new Set(['.git', 'node_modules', 'data', '.env', 'server.log', 'boot.log', '.server.pid', '.public-token', 'cloudflared.exe']);

function collect(dir, base) {
  const files = [];
  for (const name of fs.readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    if (/^(dev|test)-projects/.test(name)) continue;
    const full = path.join(dir, name);
    const rel = base ? base + '/' + name : name;
    const st = fs.statSync(full);
    if (st.isDirectory()) files.push(...collect(full, rel));
    else files.push({ name: rel, data: fs.readFileSync(full), mtime: st.mtimeMs });
  }
  return files;
}

// 打包函数（供 CLI 和服务器 /api/package 接口共用）
function buildReleaseZip() {
  const files = collect(ROOT, '');
  return { files, zip: buildZip(files) };
}

if (require.main === module) {
  const { files, zip } = buildReleaseZip();
  const parent = path.dirname(out);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true }); // 盘符根目录已存在时 mkdir 会 EPERM
  fs.writeFileSync(out, zip);
  console.log(`已生成: ${out}`);
  console.log(`文件数: ${files.length}，大小: ${(zip.length / 1024).toFixed(0)} KB`);
}

module.exports = { buildReleaseZip };
