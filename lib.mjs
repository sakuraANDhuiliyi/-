import https from 'node:https';
import crypto from 'node:crypto';

export class AppError extends Error {
  constructor(message, code = 'SERVICE_ERROR', status = 502, diagnostics = undefined) {
    super(message);
    this.code = code;
    this.status = status;
    this.diagnostics = diagnostics;
  }
}

export function cleanMessage(value, fallback = '服务暂时不可用，请稍后重试') {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  // Only brief upstream messages reach the browser; never return entire responses.
  return value.replace(/(?:https?:\/\/|(?:token|auth_code|code_verifier|authCode)\s*[:=])\S+/gi, '[已隐藏]')
    .replace(/[\u0000-\u001f]/g, ' ').slice(0, 180);
}

export function bizCode(data) {
  return Number(data?.error?.code ?? data?.code ?? 0);
}

export function checkResponse(data, httpStatus, { auth = false, diagnostics } = {}) {
  if (httpStatus === 403) throw new AppError('美团暂时拒绝了本次访问，请稍后重试。', 'UPSTREAM_FORBIDDEN', 502, diagnostics);
  if (httpStatus < 200 || httpStatus >= 300) throw new AppError(`美团接口暂时不可用（HTTP ${httpStatus}）`, 'UPSTREAM_HTTP');
  if (!data || typeof data !== 'object') throw new AppError('美团返回了无法识别的数据', 'INVALID_RESPONSE');
  const code = bizCode(data);
  const success = auth ? [0, 200].includes(code) : code === 200 && data.success !== false;
  if (!success) {
    const message = cleanMessage(data?.error?.message || data.message || data.msg);
    const expired = [401, 403, 20005].includes(code) || /token.*(无效|失效|过期)|未登录|登录.*(失效|过期)/i.test(message);
    throw new AppError(expired ? '登录已失效，请重新扫码登录' : message, expired ? 'AUTH_EXPIRED' : `UPSTREAM_${code}`, expired ? 401 : 502);
  }
  return data.data;
}

export function createTransport(cliguard, timeout = 18000, { onResponse = () => {}, requestImpl = https.request } = {}) {
  return function request(url, { method = 'POST', body, token, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      let signedUrl, signature;
      try {
        signedUrl = cliguard.addCommonParams(url).url;
        const hash = payload ? crypto.createHash('md5').update(payload.subarray(0, 16200)).digest('hex') : '';
        signature = cliguard.signRequest(method, signedUrl, hash);
        if (!signature?.mtgsig) throw new Error('missing signature');
      } catch {
        reject(new AppError('本地请求签名未能生成，请检查签名组件', 'SIGNATURE_FAILED'));
        return;
      }
      // Match run.js business headers; Passport supplies its own headers explicitly.
      const requestHeaders = {
        'X-Requested-With': 'XMLHttpRequest',
        ...signature,
        ...headers
      };
      if (payload) Object.assign(requestHeaders, { 'Content-Type': 'application/json', 'Content-Length': payload.length });
      if (token) requestHeaders.token = token;
      const startedAt = Date.now();
      const req = requestImpl(signedUrl, { method, headers: requestHeaders }, res => {
        const chunks = [];
        let length = 0;
        res.on('data', chunk => {
          length += chunk.length;
          if (length > 4 * 1024 * 1024) req.destroy(new Error('RESPONSE_TOO_LARGE'));
          else chunks.push(chunk);
        });
        res.on('end', () => {
          const bytes = Buffer.concat(chunks);
          let data;
          try { data = JSON.parse(bytes.toString('utf8')); } catch { data = null; }
          const contentType = String(res.headers['content-type'] || '').split(';')[0].toLowerCase().slice(0, 80);
          const serverDate = Date.parse(res.headers.date || '');
          const retryAfter = /^\d{1,6}$/.test(String(res.headers['retry-after'] || '')) ? Number(res.headers['retry-after']) : null;
          const upstreamCode = data?.error?.code ?? data?.code;
          const diagnostics = {
            time: new Date().toISOString(), method, path: new URL(signedUrl).pathname,
            httpStatus: res.statusCode, durationMs: Date.now() - startedAt,
            contentType, responseBytes: bytes.length,
            responseKind: data !== null ? 'json' : contentType === 'text/html' ? 'html' : 'other',
            upstreamCode: /^\d{1,10}$/.test(String(upstreamCode ?? '')) ? Number(upstreamCode) : null,
            hasForbidCode: Boolean(res.headers['x-forbid-code']),
            hasForbidReason: Boolean(res.headers['x-forbid-reason']),
            retryAfterSeconds: retryAfter,
            clockSkewSeconds: Number.isFinite(serverDate) ? Math.round((Date.now() - serverDate) / 1000) : null
          };
          // Never include request bodies, query strings, headers, signatures or response bodies.
          try { onResponse(diagnostics); } catch { /* Diagnostics must not affect requests. */ }
          resolve({ status: res.statusCode, data, diagnostics });
        });
        res.on('error', () => reject(new AppError('读取美团响应失败，请重试', 'NETWORK_ERROR')));
      });
      req.setTimeout(timeout, () => req.destroy(new Error('TIMEOUT')));
      req.on('error', error => reject(new AppError(error.message === 'TIMEOUT' ? '美团接口响应超时，请稍后重试' : '无法连接美团接口，请检查网络后重试', error.message === 'TIMEOUT' ? 'TIMEOUT' : 'NETWORK_ERROR')));
      req.end(payload);
    });
  };
}

export function validCoordinate(lat, lng) {
  return lat !== '' && lng !== '' && lat != null && lng != null && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) && Math.abs(Number(lat)) <= 90 && Math.abs(Number(lng)) <= 180;
}

export function distanceKm(text) {
  if (typeof text !== 'string') return null;
  const match = text.trim().match(/^<?\s*([\d.]+)\s*(km|m|公里|千米|米)$/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value / (/^(m|米)$/i.test(match[2]) ? 1000 : 1) : null;
}

export function safeWebUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : '';
  } catch { return ''; }
}

export function normalizeProducts(items, radius) {
  return (Array.isArray(items) ? items : []).filter(item => item && typeof item === 'object').map(item => ({
    productId: String(item.productId ?? ''),
    poiId: String(item.poiId ?? ''),
    productName: String(item.productName ?? '未命名团购'),
    poiName: String(item.poiName ?? '门店信息待补充'),
    salePrice: item.salePrice == null || !Number.isFinite(Number(item.salePrice)) ? null : Number(item.salePrice),
    distanceText: String(item.distanceText ?? ''),
    distanceKm: distanceKm(item.distanceText),
    score: item.poiDpFiveScore == null ? '' : String(item.poiDpFiveScore),
    imageUrl: safeWebUrl(item.imageUrl)
  })).filter(item => item.distanceKm === null || item.distanceKm <= radius);
}

export function createMeituanApi(request, getToken) {
  const call = async (path, body, { authenticated = true } = {}) => {
    const token = authenticated ? getToken() : '';
    if (authenticated && !token) throw new AppError('请先扫码登录美团账号', 'LOGIN_REQUIRED', 401);
    const withToken = body(token);
    const response = await request(`https://click.meituan.com/cps/ai/product/${path}`, { body: withToken, token: authenticated ? token : undefined });
    return checkResponse(response.data, response.status, { diagnostics: response.diagnostics });
  };
  return {
    async geocode(address) {
      const text = typeof address === 'string' ? address.trim() : '';
      if (text.length < 3 || text.length > 160) throw new AppError('请输入包含城市的具体地址', 'INVALID_ADDRESS', 400);
      const loc = await call('getLocationByAddress', () => ({ address: text }), { authenticated: false });
      if (!validCoordinate(loc?.lat, loc?.lng) || !loc?.cityId) throw new AppError('未能识别地址，请加上城市、区或街道后重试', 'LOCATION_NOT_FOUND');
      return { lat: String(loc.lat), lng: String(loc.lng), cityId: String(loc.cityId), address: text };
    },
    async recentLocation() {
      const loc = await call('getUserRecentLocation', token => ({ token }));
      if (!validCoordinate(loc?.lat, loc?.lng) || !loc?.cityId) throw new AppError('没有取得最近位置，请手动输入城市和地址', 'LOCATION_NOT_FOUND');
      return { lat: String(loc.lat), lng: String(loc.lng), cityId: String(loc.cityId), address: String(loc.formattedAddress || loc.cityName || '美团最近使用位置') };
    },
    async search(input) {
      const keyword = typeof input.keyword === 'string' ? input.keyword.trim() : '';
      if (!keyword || keyword.length > 80) throw new AppError('请输入 1～80 字的菜系、套餐或门店名称', 'INVALID_KEYWORD', 400);
      if (!validCoordinate(input.lat, input.lng) || !/^\d{1,8}$/.test(String(input.cityId))) throw new AppError('请先确认搜索位置', 'INVALID_LOCATION', 400);
      const page = Number(input.page ?? 1);
      const radius = Number(input.radius ?? 8);
      if (!Number.isInteger(page) || page < 1 || page > 100 || ![3, 5, 8, 15].includes(radius)) throw new AppError('搜索参数无效', 'INVALID_SEARCH', 400);
      for (const name of ['queryId', 'requestId']) {
        if (input[name] != null && String(input[name]).length > 2048) throw new AppError('翻页标识过长，请重新搜索', 'INVALID_CURSOR', 400);
      }
      const data = await call('searchProductByAgent', token => ({
        keyword, page, pageSize: '10', clientSource: 'coupon-fusion-workbuddy',
        userParamDTO: { lat: String(input.lat), lng: String(input.lng), token, cityId: String(input.cityId), app: 216, platform: 1, partner: 1018 },
        ...(input.queryId ? { queryId: String(input.queryId) } : {}),
        ...(input.requestId ? { requestId: String(input.requestId) } : {})
      }));
      if (!data || !Array.isArray(data.productList)) throw new AppError('搜索接口返回的数据结构与预期不符', 'INVALID_PRODUCTS');
      return { products: normalizeProducts(data.productList, radius), rawCount: data.productList.length, isLastPage: Boolean(data.isLastPage), queryId: String(data.queryId ?? ''), requestId: String(data.requestId ?? ''), page };
    },
    async qrCode(authUrl) {
      return safeWebUrl(await call('getQrCodeImage', () => ({ originalUrl: authUrl, clientSource: 'coupon-fusion-workbuddy' }), { authenticated: false }));
    }
  };
}
