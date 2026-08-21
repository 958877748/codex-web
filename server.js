'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./lib/config');
const sessions = require('./lib/sessions');
const Runner = require('./lib/runner');

const PORT = Number(process.env.PORT || 4000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const runner = new Runner();
const sseClients = new Set();

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function broadcast(sessionId, ev) {
  const msg = `data: ${JSON.stringify({ sessionId, event: ev })}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(msg);
    } catch {
      sseClients.delete(res);
    }
  }
}

runner.onEvent = (ev, sessionId) => broadcast(sessionId, ev);
runner.onState = (sessionId, state) => broadcast(sessionId, { seq: null, ts: new Date().toISOString(), kind: 'run_state', payload: { state } });

function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(filePath).pipe(res);
}

function handleApi(req, res, url) {
  const { pathname } = url;

  if (req.method === 'GET' && pathname === '/api/status') {
    return sendJson(res, 200, {
      ok: true,
      codexBin: runner.bin,
      running: runner.runningList(),
      sessionsCount: sessions.listSessions().length,
    });
  }

  if (req.method === 'GET' && pathname === '/api/projects') {
    return sendJson(res, 200, { projects: config.listProjects() });
  }

  if (req.method === 'GET' && pathname === '/api/sessions') {
    const list = sessions.listSessions().map((s) => ({
      ...s,
      status: runner.isRunning(s.id) ? 'running' : 'idle',
    }));
    return sendJson(res, 200, { sessions: list });
  }

  const detailMatch = pathname.match(/^\/api\/sessions\/([0-9a-f-]+)$/);
  if (req.method === 'GET' && detailMatch) {
    const detail = sessions.sessionDetail(detailMatch[1]);
    if (!detail) return sendJson(res, 404, { error: 'session not found' });
    return sendJson(res, 200, { ...detail, status: runner.isRunning(detail.id) ? 'running' : 'idle' });
  }

  if (req.method === 'POST' && pathname === '/api/sessions') {
    return readBody(req)
      .then(async (body) => {
        const cwd = String(body.cwd || '').trim();
        const prompt = String(body.prompt || '').trim();
        if (!cwd || !fs.existsSync(cwd)) return sendJson(res, 400, { error: 'cwd 不存在' });
        if (!prompt) return sendJson(res, 400, { error: 'prompt 不能为空' });
        try {
          const id = await runner.start({ cwd, prompt });
          await runner.waitFile(id, 5000);
          return sendJson(res, 201, { id });
        } catch (e) {
          return sendJson(res, 502, { error: e.message });
        }
      })
      .catch((e) => sendJson(res, 400, { error: e.message }));
  }

  const msgMatch = pathname.match(/^\/api\/sessions\/([0-9a-f-]+)\/messages$/);
  if (req.method === 'POST' && msgMatch) {
    const id = msgMatch[1];
    if (runner.isRunning(id)) return sendJson(res, 409, { error: '该会话正在运行中' });
    return readBody(req)
      .then(async (body) => {
        const prompt = String(body.prompt || '').trim();
        if (!prompt) return sendJson(res, 400, { error: 'prompt 不能为空' });
        if (!sessions.findSessionFile(id)) return sendJson(res, 404, { error: 'session not found' });
        try {
          await runner.send(id, prompt);
          return sendJson(res, 200, { ok: true });
        } catch (e) {
          return sendJson(res, 502, { error: e.message });
        }
      })
      .catch((e) => sendJson(res, 400, { error: e.message }));
  }

  const stopMatch = pathname.match(/^\/api\/sessions\/([0-9a-f-]+)\/stop$/);
  if (req.method === 'POST' && stopMatch) {
    const r = runner.stop(stopMatch[1]);
    return sendJson(res, r.ok ? 200 : 409, r);
  }

  return sendJson(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify({ sessionId: null, event: { kind: 'hello', ts: new Date().toISOString() } })}\n\n`);
    sseClients.add(res);
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(heartbeat);
        sseClients.delete(res);
      }
    }, 20000);
    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
    return;
  }

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, url);
    return;
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, '0.0.0.0', () => {
  const lanUrl = `http://${config.localIPv4()}:${PORT}/`;
  console.log('Codex Web Panel 已启动');
  console.log('Codex 二进制:', runner.bin);
  console.log('手机浏览器访问(局域网):', lanUrl);
  console.log('本机访问:', `http://127.0.0.1:${PORT}/`);
  console.log('注意:请确保 Windows 防火墙放行 Node.js 的入站连接(私有网络)。');
});

function shutdown() {
  runner.shutdown();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
