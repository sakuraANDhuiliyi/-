import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppError, checkResponse, safeWebUrl, cleanMessage, bizCode } from './lib.mjs';

const CLIENT_ID = 'c6f50b5a1e2f4e2bb00a3e2f58df3ced';
const PASSPORT = 'https://passport.meituan.com';

export function createAuth(request, runtimeDir, { onChange = () => {} } = {}) {
  const credentialFile = path.join(runtimeDir, 'credentials.json');
  let token = '';
  let savedAt = null;
  let session = null;
  let verified = false;
  try {
    const credentials = JSON.parse(fs.readFileSync(credentialFile, 'utf8'));
    token = typeof credentials.token === 'string' ? credentials.token : '';
    savedAt = credentials.savedAt ?? null;
  } catch { /* New local session. */ }

  const publicState = () => ({
    authenticated: Boolean(token), verified: Boolean(token) && verified, savedAt,
    login: session ? {
      status: session.status,
      authUrl: session.authUrl || '',
      qrImage: session.qrImage || '',
      expiresAt: session.expiresAt,
      message: session.message || ''
    } : null
  });
  const notify = () => onChange(publicState());
  function cancel() {
    if (session?.timer) clearTimeout(session.timer);
    session = null;
  }
  function persist(newToken) {
    fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(runtimeDir, 0o700);
    const temporary = `${credentialFile}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ token: newToken, savedAt: new Date().toISOString() }), { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, credentialFile);
    token = newToken;
    savedAt = new Date().toISOString();
    verified = false;
  }
  function invalidate() {
    cancel();
    token = '';
    savedAt = null;
    verified = false;
    try { fs.unlinkSync(credentialFile); } catch { /* No stored token. */ }
    notify();
  }
  async function poll(current) {
    if (session !== current || current.status !== 'waiting') return;
    if (Date.now() >= current.expiresAt) {
      current.status = 'expired';
      current.message = '登录链接已过期，请重新获取二维码';
      notify();
      return;
    }
    try {
      const url = new URL(`${PASSPORT}/api/account/userauth/check`);
      url.search = new URLSearchParams({ client_id: CLIENT_ID, auth_code: current.authCode, code_verifier: current.verifier }).toString();
      const response = await request(url.href, { method: 'GET', headers: { 'Cache-Control': 'no-cache' } });
      if (session !== current) return;
      const code = bizCode(response.data);
      if (![0, 200].includes(code) && response.status === 200 && ![101000].includes(code)) {
        throw new AppError(cleanMessage(response.data?.error?.message || response.data?.message || response.data?.msg, '授权未能完成，请重新扫码'), `AUTH_${code}`);
      }
      if (response.status !== 200) checkResponse(response.data, response.status, { auth: true });
      const data = response.data?.data;
      if (data?.authStatus === 4 && typeof data.token === 'string' && data.token) {
        persist(data.token);
        current.status = 'success';
        current.authUrl = '';
        current.qrImage = '';
        delete current.authCode;
        delete current.verifier;
        notify();
        return;
      }
      if (data?.authStatus === 2 || data?.authStatus === 3) {
        current.status = 'failed';
        current.message = data.authStatus === 2 ? '你已取消本次授权，可以重新扫码' : '美团拒绝了此次授权，请在美团 App 检查后重试';
        notify();
        return;
      }
      current.message = '';
    } catch (error) {
      if (session !== current) return;
      if (['NETWORK_ERROR', 'TIMEOUT'].includes(error.code)) current.message = '连接有些慢，正在继续等待扫码结果…';
      else {
        current.status = 'failed';
        current.message = error instanceof AppError ? error.message : '授权服务暂时不可用，请重新尝试';
        notify();
        return;
      }
    }
    current.timer = setTimeout(() => poll(current), 3000);
    current.timer.unref?.();
  }
  return {
    state: publicState,
    getToken: () => token,
    markVerified() { verified = true; },
    invalidate,
    close: cancel,
    async start(makeQr) {
      if (session?.status === 'waiting' && session.expiresAt > Date.now()) return publicState();
      cancel();
      const verifier = crypto.randomBytes(32).toString('hex');
      const challenge = crypto.createHash('sha256').update(verifier).digest('hex');
      const url = new URL(`${PASSPORT}/api/account/userauth/code`);
      url.search = new URLSearchParams({ client_id: CLIENT_ID, code_challenge: challenge }).toString();
      const response = await request(url.href, { method: 'GET', headers: { 'Cache-Control': 'no-cache' } });
      const data = checkResponse(response.data, response.status, { auth: true });
      const authUrl = safeWebUrl(data?.shortLink);
      if (!data?.authCode || !authUrl) throw new AppError('授权接口未返回可用登录链接', 'INVALID_AUTH_RESPONSE');
      const current = session = { status: 'waiting', authUrl, authCode: String(data.authCode), verifier, expiresAt: Date.now() + 600000, message: '' };
      current.timer = setTimeout(() => poll(current), 800);
      current.timer.unref?.();
      // QR service failure leaves the native authorization link available.
      Promise.resolve().then(() => makeQr(authUrl)).then(image => {
        if (session === current && current.status === 'waiting') { current.qrImage = image; notify(); }
      }).catch(() => {});
      notify();
      return publicState();
    }
  };
}
