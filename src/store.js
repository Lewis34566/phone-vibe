'use strict';
// 会话历史本地存储：纯 JSON 文件，零依赖
const fs = require('fs');
const path = require('path');
const { dataDir } = require('./config');

const HISTORY_DIR = path.join(dataDir, 'history');
fs.mkdirSync(HISTORY_DIR, { recursive: true });

// 会话索引：[{id, project, title, createdAt, updatedAt}]
const INDEX_FILE = path.join(HISTORY_DIR, 'index.json');

function loadIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch { return []; }
}
function saveIndex(list) {
  const tmp = INDEX_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list));
  fs.renameSync(tmp, INDEX_FILE);
}
function sessionFile(id) { return path.join(HISTORY_DIR, id + '.json'); }

function loadSession(id) {
  try { return JSON.parse(fs.readFileSync(sessionFile(id), 'utf8')); } catch { return null; }
}
function saveSession(s) {
  const tmp = sessionFile(s.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, sessionFile(s.id));
  const idx = loadIndex().filter((x) => x.id !== s.id);
  idx.unshift({ id: s.id, project: s.project, title: s.title, createdAt: s.createdAt, updatedAt: Date.now() });
  if (idx.length > 200) idx.length = 200;
  saveIndex(idx);
}
function deleteSession(id) {
  try { fs.unlinkSync(sessionFile(id)); } catch {}
  saveIndex(loadIndex().filter((x) => x.id !== id));
}
function listSessions(project) {
  const all = loadIndex();
  return project ? all.filter((x) => x.project === project) : all;
}

module.exports = { loadSession, saveSession, deleteSession, listSessions };
