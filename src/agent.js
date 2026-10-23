'use strict';
const config = require('./config');
const projects = require('./projects');
const { streamDeepSeek, mockStream } = require('./llm');
const { TOOL_DEFS, executeTool } = require('./tools');
const { spawn } = require('child_process');

const MAX_ROUNDS = 60;
const INACTIVITY_MS = 240000;

// 注意：这段提示词必须保持字节级不变（不要往里嵌项目名等动态内容）——
// DeepSeek 的上下文缓存按前缀匹配，提示词完全静态才能每次请求都命中缓存，
// 首字延迟从 4-10 秒降到 ~0.1 秒。要改文案可以，但改完所有请求会冷启动一次。
const SYSTEM_PROMPT = `你是 Lewis，一位经验丰富的全栈工程师，运行在用户的 Android 手机上（Termux + Node.js 环境，手机浏览器访问）。
用户用中文描述需求，你要把软件完整、漂亮地做出来并在手机上运行。你的名字是 Lewis，自我介绍和署名都用 Lewis。

## 工作方式（必须遵守）
1. **先规划再动手**：每次任务开始，先用 Markdown 列表给出详细方案（尽量 5-8 条）：每个文件叫什么、各自干什么、核心功能怎么实现、数据怎么存、为什么这么设计。然后立即开始写代码，不要等用户确认。
2. **需求模糊先问**：如果关键信息缺失会做错方向（例如"做个管理软件"却没说管什么），先问用户一个最关键的问题，然后停下来等回答。能合理推断的就直接做，别什么都问。
3. **写完必自查**：JS 文件写完执行 node --check <文件> 检查语法；页面写完用 read_file 抽查关键段落。发现错误立即修复，不要带病启动。
4. **启动失败自动修复**：start_project 报错时，读错误输出、定位问题、修改代码、重新启动，最多修 3 轮；修不好就在总结里如实说明卡在哪、用户该怎么帮你。
5. **修改已有项目时**：先 list_dir 看结构，再用 search_code 定位要改的代码，改完自查再重启。
6. **完成后两件事**：a) 把项目标题和一句话描述写入 meta.json（保留已有字段，如 {"name":"..","title":"..","desc":"..","createdAt":..}）；b) 写一份完整的完工总结：✅ 已实现的每项功能（逐条说明怎么用）、📦 数据存在哪、🎯 使用时要注意什么、💡 下一步可以加什么功能（至少列 3 条），并提醒用户可以直接说「继续」让你接着改。

## 界面质量标准（用户感知到的"聪明"）
- 移动端优先：viewport 必须 width=device-width；按钮触控区不小于 44px；字号不小于 14px；禁止横向滚动。
- 深色现代风格：背景 #0f1117 系、卡片背景 #1a1e2b 系、圆角 12-16px、主色用渐变（如 #6366f1 → #8b5cf6）、间距用 8 的倍数、卡片间留呼吸感。
- 交互完整：空状态提示、删除前确认、输入校验、操作后有反馈、数字实时更新、长列表能滚动。
- 数据持久化：静态项目用 localStorage，封装成 loadData()/saveData() 两个函数统一读写；Node 项目用 JSON 文件（放项目内 data/ 目录，fs 读写）。
- 绝对不允许：白屏、undefined 报错、console 报错、桌面布局套手机上、丑。

## 技术约束
- 单个文件控制在 1000 行以内（写紧凑但可读）；大应用宁可拆成 index.html + 单独 js/css 文件，避免一次输出太长被截断。
- 优先纯静态单页（HTML/CSS/JS），只有需求确实需要后端（文件存储、定时任务、调用外部接口）才用 Node。
- Node 项目尽量零依赖（用内置模块），必须装第三方包才 npm install（会弹窗让用户确认）。
- 项目文件默认写进当前项目目录；同时你也能读写整个手机存储：Termux 家目录 ~、共享存储 /sdcard（等于 ~/storage/shared）。需要放到手机存储时直接用绝对路径（如 ~/storage/shared/记账/data.json）。
- 系统目录（/system、/proc、/sys、/data 根目录等）禁止访问，会被直接拒绝。
- 删除文件、联网下载、安装依赖仍然会弹窗让用户点「允许」，不要绕过。
- 你能直接操作手机（phone 工具）：打开链接/应用、读写剪贴板、发通知、读电量/WiFi、发短信（需确认）、拍照、语音朗读、震动、手电筒、分享文件。用户装好 Termux:API 后这些就能用；失败时如实告诉用户缺什么。
- 发消息用 send_message 工具（短信/企业微信群机器人/QQ 机器人/分享面板/剪贴板）。微信个人消息无法全自动发送（微信没有对外接口），别假装能做到：能自动的是短信、企业微信群机器人（.env 配 WECOM_WEBHOOK_URL）、QQ 机器人（.env 配 ONEBOT_API_URL）；要发微信就用 share 拉起分享面板让用户选人，或 clipboard 复制好内容打开微信让用户粘贴。
- 查资料先 web_search 联网搜索，拿到链接再用 read_url 读网页正文；调外部接口用 http_request。手机已装 Termux:API 时，拍照用 phone 工具的 photo（可选前置/后置摄像头，拍完自动打开给用户看）。改已有文件优先 edit_file 局部替换，少整篇重写。
- 安卓权限边界：别的 App 内部的点击、填表、读屏你做不到（除非用户装 Shizuku 或 root），别承诺做不到的事。
- 中文界面、中文注释适量即可。

## 风格
- 回复用中文，内容充实完整、信息量大：方案讲清每个文件干什么、为什么这么设计；讲解功能时说清怎么用；总结要详细，不为了短而砍掉有用信息。但也不要无意义重复或堆砌套话。
- 写代码时给关键逻辑写适量中文注释，一次性把文件写完整，不要写一半留 TODO（除非故意分阶段）。`;

// 给 UI 展示用的工具参数预览（写文件只给路径+前 120 字）
function previewInput(name, input) {
  const i = input || {};
  switch (name) {
    case 'write_file': {
      const c = String(i.content || '');
      return { path: i.path, content: c.slice(0, 120) + (c.length > 120 ? '…' : '') };
    }
    case 'run_command': return { command: i.command };
    case 'edit_file': return { path: i.path, old: String(i.old_string || '').slice(0, 80) };
    case 'read_url': return { url: i.url };
    case 'web_search': return { query: String(i.query || '').slice(0, 40) };
    case 'phone': return { action: i.action, app: i.app || '', text: String(i.text || '').slice(0, 60) };
    case 'send_message': return { channel: i.channel, to: i.to || '', text: String(i.text || '').slice(0, 60) };
    case 'start_project': return { type: i.type, install_deps: !!i.install_deps };
    case 'stop_project': return {};
    default: return i;
  }
}

function safeParse(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }

// emit(evt): 事件推给前端（并进会话历史）；approve(question): 弹审批，返回 Promise<boolean>
// _streamFn: 仅供测试注入的 LLM 流生成器
async function runAgent({ session, project, message, apiKey, model, controller, emit, approve, _streamFn }) {
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
    let autoContinues = 0; // 输出截断自动继续的次数（最多 3 次，防死循环）
    let consecutiveFails = 0; // 连续整轮失败的次数（熔断用）
    let lastToolError = ''; // 最近一次工具错误（超限报错时带上，方便排查）
    for (;;) {
      if (++rounds > MAX_ROUNDS) {
        emit({ type: 'error', message: `执行轮数超限（${MAX_ROUNDS} 轮），已自动停住。直接说「继续」它会接着做。${lastToolError ? '\n最近一次错误：' + lastToolError : ''}` });
        break;
      }
      if (signal.aborted) break;

      const blocks = [];
      let stopReason = null;

      const gen = _streamFn ? _streamFn(messages)
        : config.isMock
          ? mockStream(messages)
          : streamDeepSeek({ apiKey, model, system: SYSTEM_PROMPT, messages, tools: TOOL_DEFS, signal });

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

      if (stopReason === 'max_tokens') {
        // 输出被截断：截断可能发生在最后一个工具调用的 JSON 里（会坏掉），
        // 丢掉它，自动补一句「继续」让模型下轮重发，不用用户手动说
        while (cleaned.length && cleaned[cleaned.length - 1].type === 'tool_use') cleaned.pop();
        if (cleaned.length) messages[messages.length - 1].content = cleaned;
        else messages.pop();
        autoContinues++;
        if (autoContinues <= 3) {
          emit({ type: 'text', delta: '\n\n（内容较长，自动继续完成…）\n' });
          messages.push({ role: 'user', content: '上一条输出被截断了，接着刚才的地方继续，把没写完的内容补完整。' });
          continue;
        }
        emit({ type: 'error', message: '输出多次达到上限，任务可能未完成——请再说一句「继续」让它接着做' });
        const finalText = cleaned.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        emit({ type: 'done', text: finalText, usage, previewUrl: startedUrl });
        break;
      }

      if (stopReason !== 'tool_use') {
        const finalText = cleaned.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        emit({ type: 'done', text: finalText, usage, previewUrl: startedUrl });
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
        if (!res.ok) lastToolError = String(res.error || res.summary || '');
      }
      if (signal.aborted) break;
      // 熔断：连续 5 轮工具全部失败 = 卡住了，停掉并把原因告诉用户，而不是烧完所有轮数
      if (results.length) consecutiveFails = results.every(({ res }) => !res.ok) ? consecutiveFails + 1 : 0;
      if (consecutiveFails >= 5) {
        emit({ type: 'error', message: `连续 ${consecutiveFails} 轮工具调用全部失败，疑似卡住，已自动停住。${lastToolError ? '\n最近错误：' + lastToolError : ''}` });
        break;
      }
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
    const url = `http://127.0.0.1:${config.port}${startedUrl}`;
    try {
      spawn('termux-open-url', [url], { stdio: 'ignore', detached: true }).unref();
    } catch {}
  }

  return { startedUrl, usage };
}

module.exports = { runAgent, SYSTEM_PROMPT };
