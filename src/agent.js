'use strict';
const config = require('./config');
const projects = require('./projects');
const { streamClaude, mockStream } = require('./anthropic');
const { TOOL_DEFS, executeTool } = require('./tools');
const { spawn } = require('child_process');

const MAX_ROUNDS = 40;
const INACTIVITY_MS = 240000;

const SYSTEM_PROMPT = (project) => `你是运行在用户 Android 手机上的全栈编程智能体（Termux + Node.js 环境，手机浏览器访问）。
用户会用中文描述想要的应用，你要自己写代码把它做出来，并在手机上打开给用户用。当前项目名：${project}。

铁律：
1. 你只能读写当前项目目录及其子目录，绝对禁止访问项目目录以外的任何路径。
2. 删除文件、联网下载、安装依赖都会弹窗让用户确认；被拒绝就换方案，不要重复试同一个命令。
3. 优先做纯静态单页应用（HTML/CSS/JS），移动端优先、中文界面、触屏友好、数据用 localStorage。只有需求确实需要后端（如把数据存成文件、定时任务、调用外部接口）才用 Node。
4. Node 项目尽量零依赖（用 Node 内置模块），必须用第三方包时才 npm install。
5. 写完代码先自查（read_file 抽查关键文件），再用 start_project 启动，最后回复简短总结并给出预览地址 /p/<项目名>/。
6. 每个需求先快速规划（2-4 条），然后直接动手，不要长篇大论。回复用中文，简洁。
7. 写 HTML 时 viewport 用 width=device-width，字号不小于 14px，按钮要适合手指点按。`;

// 给 UI 展示用的工具参数预览（写文件只给路径+前 120 字）
function previewInput(name, input) {
  const i = input || {};
  switch (name) {
    case 'write_file': {
      const c = String(i.content || '');
      return { path: i.path, content: c.slice(0, 120) + (c.length > 120 ? '…' : '') };
    }
    case 'run_command': return { command: i.command };
    case 'start_project': return { type: i.type, install_deps: !!i.install_deps };
    case 'stop_project': return {};
    default: return i;
  }
}

function safeParse(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }

// emit(evt): 事件推给前端（并进会话历史）；approve(question): 弹审批，返回 Promise<boolean>
async function runAgent({ session, project, message, apiKey, model, controller, emit, approve }) {
  const signal = controller.signal;
  let cancelled = false;
  let timedOut = false;
  controller.signal.addEventListener('abort', () => { cancelled = true; }, { once: true });

  let inactivityTimer = null;
  const resetTimer = () => {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, INACTIVITY_MS);
  };

  const state = { send: emit, approve, signal };
  const ctx = { projectDir: projects.projectPath(project), projectName: project, state };

  const messages = (session.messages || []).slice();
  messages.push({ role: 'user', content: message });

  let startedUrl = null;
  const usage = { input: 0, output: 0 };
  resetTimer();

  try {
    let rounds = 0;
    for (;;) {
      if (++rounds > MAX_ROUNDS) { emit({ type: 'error', message: '执行轮数超限，已停止' }); break; }
      if (signal.aborted) break;

      const blocks = [];
      let stopReason = null;

      const gen = config.isMock
        ? mockStream(messages)
        : streamClaude({ apiKey, model, system: SYSTEM_PROMPT(project), messages, tools: TOOL_DEFS, signal });

      for await (const evt of gen) {
        resetTimer();
        if (evt.type === 'message_start' && evt.message?.usage) usage.input += evt.message.usage.input_tokens || 0;
        else if (evt.type === 'content_block_start') blocks[evt.index] = evt.content_block;
        else if (evt.type === 'content_block_delta') {
          const b = blocks[evt.index] = blocks[evt.index] || {};
          if (evt.delta.type === 'text_delta') {
            b.text = (b.text || '') + evt.delta.text;
            emit({ type: 'text', delta: evt.delta.text });
          } else if (evt.delta.type === 'input_json_delta') {
            // content_block_start 里 input 是 {}，要丢掉对象值从头拼 JSON 字符串
            b.input = typeof b.input === 'string' ? b.input + evt.delta.partial_json : evt.delta.partial_json;
          }
        } else if (evt.type === 'message_delta') {
          stopReason = evt.delta?.stop_reason || stopReason;
          if (evt.usage?.output_tokens) usage.output += evt.usage.output_tokens;
        }
      }

      const cleaned = blocks.filter(Boolean).map((b) => b.type === 'text'
        ? { type: 'text', text: b.text || '' }
        : { type: 'tool_use', id: b.id, name: b.name, input: safeParse(b.input) });

      if (!cleaned.length) { emit({ type: 'error', message: '模型没有返回内容，请重试' }); break; }
      messages.push({ role: 'assistant', content: cleaned });

      if (stopReason !== 'tool_use') {
        if (stopReason === 'max_tokens') {
          emit({ type: 'error', message: '输出达到上限，任务可能未完成——请再说一句「继续」让它接着做' });
        }
        const finalText = cleaned.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        emit({ type: 'done', text: finalText, usage });
        break;
      }

      // 执行工具
      const results = [];
      for (const tu of cleaned.filter((b) => b.type === 'tool_use')) {
        if (signal.aborted) break;
        emit({ type: 'tool_call', id: tu.id, name: tu.name, input: previewInput(tu.name, tu.input) });
        resetTimer();
        let res;
        try {
          res = await executeTool(tu.name, tu.input, ctx);
          if (tu.name === 'start_project' && res.ok && res.data?.url) startedUrl = res.data.url;
        } catch (e) {
          res = { ok: false, error: String((e && e.message) || e) };
        }
        emit({
          type: 'tool_result',
          id: tu.id,
          name: tu.name,
          ok: !!res.ok,
          summary: res.summary || (res.error ? '失败' : '完成'),
          output: (res.output || '').slice(0, 4000),
          needsInstall: !!res.data?.needsInstall,
        });
        results.push({ tu, res });
      }
      if (signal.aborted) break;
      messages.push({
        role: 'user',
        content: results.map(({ tu, res }) => ({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: res.ok
            ? JSON.stringify({ ok: true, summary: res.summary, data: res.data, output: (res.output || '').slice(0, 4000) })
            : `错误: ${res.error || '失败'}`,
          is_error: !res.ok,
        })),
      });
    }
  } catch (e) {
    if (timedOut) emit({ type: 'error', message: `任务超时（${INACTIVITY_MS / 60000} 分钟无响应），已停止` });
    else if (signal.aborted && cancelled) emit({ type: 'cancelled' });
    else emit({ type: 'error', message: String((e && e.message) || e) });
  }

  clearTimeout(inactivityTimer);

  // 完成后自动在手机浏览器打开预览（termux-open-url 拉起默认浏览器）
  if (startedUrl && config.autoOpen && config.IS_ANDROID) {
    const url = `http://localhost:${config.port}${startedUrl}`;
    try {
      spawn('termux-open-url', [url], { stdio: 'ignore', detached: true }).unref();
    } catch {}
  }

  return { startedUrl, usage };
}

module.exports = { runAgent, SYSTEM_PROMPT };
