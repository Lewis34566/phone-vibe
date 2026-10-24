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
  // Key 通用字段优先，向后兼容各旧写法
  get apiKey() { return (env.LLM_API_KEY || env.DEEPSEEK_API_KEY || env.OPENAI_API_KEY || env.API_KEY || env.ANTHROPIC_API_KEY || '').trim(); },
  get configured() { return this.apiKey.length > 10; },
  get model() { return env.MODEL || 'deepseek-v4-pro'; },
  // 主模型接口地址（OpenAI 兼容即可，任何 AI 公司都行）：
  // DeepSeek 默认；OpenAI=https://api.openai.com/v1/chat/completions；
  // 通义千问=https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions；
  // 智谱=https://open.bigmodel.cn/api/paas/v4/chat/completions；
  // Kimi=https://api.moonshot.cn/v1/chat/completions
  get llmApiUrl() { return String(env.LLM_API_URL || 'https://api.deepseek.com/chat/completions').trim(); },
  // 图片理解模型（走主接口同家服务商，各家视觉模型名不同）
  get visionModel() { return String(env.VISION_MODEL || 'deepseek-flash').trim(); },
  get port() { const p = parseInt(env.PORT || '8787', 10); return Number.isFinite(p) ? p : 8787; },
  get autoOpen() { return env.AUTO_OPEN !== '0' && env.NO_AUTO_OPEN !== '1'; },
  get projectsDir() { return projectsDir(); },
  get dataDir() { return env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(APP_DIR, 'data'); },
  get isMock() { return this.apiKey === 'mock'; },
  // v1.5：是否允许 Lewis 读写项目目录以外的手机存储（默认允许）。
  // 想恢复"只能在项目文件夹里干活"的沙盒模式：.env 里写 ALLOW_ANY_PATH=0
  get allowAnyPath() { return env.ALLOW_ANY_PATH !== '0'; },
  // 局域网/公网访问密码（本机 127.0.0.1 免密）；install.sh 首次安装自动生成写进 .env
  get accessToken() { return String(env.ACCESS_TOKEN || '').trim(); },
  // 发消息通道（.env 配置后 send_message 工具可用）：
  // WECOM_WEBHOOK_URL=企业微信群机器人 webhook；ONEBOT_API_URL=QQ OneBot 机器人（如 NapCat）HTTP API 地址
  get wecomWebhook() { return String(env.WECOM_WEBHOOK_URL || '').trim(); },
  get onebotApi() { return String(env.ONEBOT_API_URL || '').trim().replace(/\/+$/, ''); },
  // 离线兜底：本地模型（ollama 的 OpenAI 兼容接口）。DeepSeek 断网时自动切换
  get localLlmUrl() { return String(env.LOCAL_LLM_URL || '').trim().replace(/\/+$/, ''); },
  get localLlmModel() { return String(env.LOCAL_LLM_MODEL || 'qwen2.5:3b').trim(); },
  // 服务端版本号（从 package.json 读，/api/state 会返回，用来确认手机上跑的是哪一版）
  get version() { try { return require('../package.json').version || '0.0.0'; } catch { return '0.0.0'; } },
  lanIPs,
  reload,
  // 把 API Key 写入 .env（统一写成通用字段 LLM_API_KEY，兼容替换旧字段名，原子写）
  saveApiKey(key) {
    const p = path.join(APP_DIR, '.env');
    const lines = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split(/\r?\n/) : [];
    let done = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(LLM_API_KEY|DEEPSEEK_API_KEY|OPENAI_API_KEY|API_KEY|ANTHROPIC_API_KEY)\s*=/.test(lines[i])) {
        lines[i] = `LLM_API_KEY=${key.trim()}`;
        done = true;
        break;
      }
    }
    if (!done) {
      if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
      lines.push(`LLM_API_KEY=${key.trim()}`);
    }
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, lines.join('\n') + '\n');
    fs.renameSync(tmp, p);
    reload();
  },
  // 改任意一项配置并写回 .env（模型、自动打开等）
  saveSetting(key, value) {
    if (!/^[A-Z0-9_]+$/.test(key)) throw new Error('非法配置名');
    const p = path.join(APP_DIR, '.env');
    const lines = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split(/\r?\n/) : [];
    const re = new RegExp('^\\s*' + key + '\\s*=');
    let done = false;
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) { lines[i] = `${key}=${value}`; done = true; break; }
    }
    if (!done) {
      if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
      lines.push(`${key}=${value}`);
    }
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, lines.join('\n') + '\n');
    fs.renameSync(tmp, p);
    reload();
  },
};
