import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { AppError, createTransport, createMeituanApi } from './lib.mjs';
import { createAuth } from './auth.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const cliguard = require('./vendor/cliguard.cjs');
let lastSearchResponse = null;
const request = createTransport(cliguard, 18000, { onResponse(record) {
  if (record.path.endsWith('/searchProductByAgent')) lastSearchResponse = record;
  try {
    const runtime = path.join(directory, '.runtime');
    const log = path.join(runtime, 'upstream.jsonl');
    fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
    if (fs.existsSync(log) && fs.statSync(log).size > 256 * 1024) fs.truncateSync(log);
    fs.appendFileSync(log, JSON.stringify(record) + '\n', { mode: 0o600 });
    fs.chmodSync(log, 0o600);
  } catch { /* Local diagnostics are optional. */ }
} });
const auth = createAuth(request, path.join(directory, '.runtime'), { onChange(state) {
  if (state.login?.status === 'success' || !state.authenticated) {
    lastSearchResponse = null;
    serviceState = { status: 'unverified', message: state.authenticated ? '已重新授权，等待搜索验证' : '等待登录和查询验证', checkedAt: null };
  }
} });
const api = createMeituanApi(request, auth.getToken);
const publicDir = path.join(directory, 'public');
const port = Number(process.env.MEITUAN_WEB_PORT || 3217);
let actualPort = port;
let authStarting = null;
let serviceState = { status: 'unverified', message: '等待首次连接美团接口', checkedAt: null };

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
async function readBody(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk.toString('utf8');
    if (Buffer.byteLength(text) > 12000) throw new AppError('请求内容过长', 'BODY_TOO_LARGE', 413);
  }
  try { return text ? JSON.parse(text) : {}; }
  catch { throw new AppError('请求格式不正确', 'INVALID_JSON', 400); }
}
function sameOrigin(req) {
  const host = req.headers.host;
  if (![`127.0.0.1:${actualPort}`, `localhost:${actualPort}`].includes(host)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  return !req.headers.origin || [`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`].includes(req.headers.origin);
}
function success() { serviceState = { status: 'connected', message: '已收到美团接口响应', checkedAt: new Date().toISOString() }; }

const server = http.createServer(async (req, res) => {
  if (!sameOrigin(req)) return json(res, 403, { ok: false, error: { code: 'ORIGIN_REJECTED', message: '此服务仅供本机页面访问' } });
  const pathname = new URL(req.url, `http://127.0.0.1:${actualPort}`).pathname;
  try {
    if (req.method === 'GET' && pathname === '/api/status') return json(res, 200, { ok: true, ...auth.state(), service: serviceState, lastSearch: lastSearchResponse });
    if (req.method === 'POST' && pathname.startsWith('/api/')) {
      if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError('请求格式不正确', 'INVALID_CONTENT_TYPE', 415);
      const body = await readBody(req);
      let data;
      switch (pathname) {
        case '/api/auth/start':
          if (!authStarting) authStarting = auth.start(api.qrCode).finally(() => { authStarting = null; });
          data = await authStarting;
          break;
        case '/api/auth/logout':
          auth.invalidate(); data = auth.state(); break;
        case '/api/location/address':
          data = await api.geocode(body.address); break;
        case '/api/location/recent':
          data = await api.recentLocation(); auth.markVerified(); break;
        case '/api/search':
          data = await api.search(body); auth.markVerified(); break;
        default:
          throw new AppError('页面功能不存在', 'NOT_FOUND', 404);
      }
      if (pathname !== '/api/auth/logout') success();
      return json(res, 200, { ok: true, data });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '不支持的请求方法' } });
    const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
    const file = files[pathname];
    if (!file) throw new AppError('页面不存在', 'NOT_FOUND', 404);
    res.writeHead(200, {
      'Content-Type': file[1], 'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    });
    res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(path.join(publicDir, file[0])));
  } catch (error) {
    if (error.code === 'AUTH_EXPIRED') auth.invalidate();
    const exposed = error instanceof AppError ? error : new AppError('本地服务发生异常，请重试', 'INTERNAL_ERROR', 500);
    if (exposed.status >= 500) serviceState = { status: 'error', message: exposed.message, code: exposed.code, checkedAt: new Date().toISOString() };
    json(res, exposed.status, { ok: false, error: { code: exposed.code, message: exposed.message } });
  }
});
server.on('error', error => {
  if (error.code === 'EADDRINUSE' && actualPort < port + 10) { actualPort++; server.listen(actualPort, '127.0.0.1'); }
  else { console.error('本地服务未能启动：', error.code || 'UNKNOWN'); process.exitCode = 1; }
});
server.listen(actualPort, '127.0.0.1', () => console.log(`团购浏览已启动：http://127.0.0.1:${actualPort}`));
function close() { auth.close(); server.close(() => process.exit(0)); }
process.on('SIGTERM', close);
process.on('SIGINT', close);
