'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');

// ---- .env 解析（简陋但零依赖，够用）----
function loadEnvFile() {
  const p = path.join(APP_DIR, '.env');
  const out = {};
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

let fileEnv = loadEnvFile();
// 进程环境变量优先（PORT=xxx bash start.sh 可覆盖）
const env = { ...fileEnv, ...process.env };

function reload() {
  fileEnv = loadEnvFile();
  for (const k of Object.keys(env)) delete env[k];
  Object.assign(env, fileEnv, process.env); // 进程环境变量始终优先
}

const IS_ANDROID = process.platform === 'android';

function projectsDir() {
  if (env.PHONE_PROJECTS_DIR) return path.resolve(env.PHONE_PROJECTS_DIR);
  if (IS_ANDROID) return path.join(os.homedir(), 'storage', 'shared', 'PhoneProjects');
  return path.join(APP_DIR, 'dev-projects'); // 电脑上开发/自测用
}

function lanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const it of ifs[name] || []) {
      if (it.family === 'IPv4' && !it.internal) out.push(it.address);
    }
  }
  return [...new Set(out)];
}

module.exports = {
  APP_DIR,
  IS_ANDROID,
  get apiKey() { return (env.ANTHROPIC_API_KEY || '').trim(); },
  get configured() { return this.apiKey.length > 10; },
  get model() { return env.MODEL || 'claude-sonnet-5-5'; },
  get port() { const p = parseInt(env.PORT || '8787', 10); return Number.isFinite(p) ? p : 8787; },
  get autoOpen() { return env.AUTO_OPEN !== '0' && env.NO_AUTO_OPEN !== '1'; },
  get projectsDir() { return projectsDir(); },
  get dataDir() { return env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(APP_DIR, 'data'); },
  get isMock() { return this.apiKey === 'mock'; },
  lanIPs,
  reload,
  // 把 API Key 写入 .env（保留其他行，原子写）
  saveApiKey(key) {
    const p = path.join(APP_DIR, '.env');
    const lines = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split(/\r?\n/) : [];
    let done = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*ANTHROPIC_API_KEY\s*=/.test(lines[i])) {
        lines[i] = `ANTHROPIC_API_KEY=${key.trim()}`;
        done = true;
        break;
      }
    }
    if (!done) {
      if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
      lines.push(`ANTHROPIC_API_KEY=${key.trim()}`);
    }
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, lines.join('\n') + '\n');
    fs.renameSync(tmp, p);
    reload();
  },
};
