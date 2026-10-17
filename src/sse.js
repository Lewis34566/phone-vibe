'use strict';
// 极简 SSE：一个 HTTP 响应 + 发送函数 + 心跳
function startSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  let closed = false;
  const onClose = () => { closed = true; clearInterval(hb); };
  res.on('close', onClose);
  const hb = setInterval(() => { if (!closed) { try { res.write(': ping\n\n'); } catch {} } }, 15000);
  return {
    send(obj) {
      if (!closed) {
        try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {}
      }
    },
    end() {
      if (!closed) { try { res.end(); } catch {} }
      closed = true;
      clearInterval(hb);
    },
    get closed() { return closed; },
  };
}

module.exports = { startSSE };
