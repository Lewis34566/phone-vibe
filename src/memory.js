'use strict';
// 长期记忆：跨会话记住用户的重要信息和偏好
// 存 data/memory.json；注入到每个新会话的首条用户消息里（不放进系统提示词，
// 保证 DeepSeek 上下文缓存的系统+工具前缀保持字节级不变）
const fs = require('fs');
const path = require('path');
const config = require('./config');

const FILE = path.join(config.dataDir, 'memory.json');
const MAX_ITEMS = 50;

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(j.items)) return j.items.filter((i) => i && typeof i.text === 'string');
  } catch {}
  return [];
}

function save(items) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ items: items.slice(-MAX_ITEMS) }, null, 2));
    fs.renameSync(tmp, FILE);
  } catch {}
}

function add(text) {
  const items = load();
  items.push({ text: String(text || '').trim().slice(0, 500), ts: Date.now() });
  // 去重：完全相同的只保留最新
  const seen = new Set();
  const dedup = [];
  for (let i = items.length - 1; i >= 0; i--) {
    if (!seen.has(items[i].text)) { seen.add(items[i].text); dedup.push(items[i]); }
  }
  dedup.reverse();
  save(dedup);
  return dedup.length;
}

function list() {
  return load();
}

function clear() {
  save([]);
  return 0;
}

// 注入用的记忆文本（截断控制体积）
function injectText() {
  const items = load();
  if (!items.length) return '';
  return items.slice(-20).map((i) => '- ' + i.text).join('\n');
}

module.exports = { add, list, clear, injectText };
