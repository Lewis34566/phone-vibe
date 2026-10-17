'use strict';
const http = require('http');
const net = require('net');

// 极简反向代理：把 /p/<项目>/ 的请求转发到 127.0.0.1:<port>
function httpProxy(req, res, port) {
  const headers = { ...req.headers, host: `127.0.0.1:${port}` };
  delete headers['proxy-connection'];
  const preq = http.request(
    { host: '127.0.0.1', port, method: req.method, path: req.url, headers },
    (pres) => {
      res.writeHead(pres.statusCode || 502, pres.headers);
      pres.pipe(res);
    }
  );
  preq.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`项目进程无响应（可能已崩溃或还在启动）：${e.message}`);
  });
  req.pipe(preq);
}

// WebSocket 升级透传：Vite / React 热更新等场景需要
function wsProxy(req, socket, head, port) {
  const target = net.connect(port, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    const raw = req.rawHeaders;
    for (let i = 0; i < raw.length; i += 2) {
      const k = raw[i].toLowerCase();
      if (['connection', 'upgrade', 'transfer-encoding'].includes(k)) continue;
      lines.push(`${raw[i]}: ${raw[i + 1]}`);
    }
    lines.push('Connection: Upgrade', 'Upgrade: websocket', '', '');
    target.write(lines.join('\r\n'));
    if (head && head.length) target.write(head);
    socket.pipe(target);
    target.pipe(socket);
  });
  target.on('error', () => socket.destroy());
  socket.on('error', () => target.destroy());
  socket.on('close', () => target.destroy());
}

module.exports = { httpProxy, wsProxy };
