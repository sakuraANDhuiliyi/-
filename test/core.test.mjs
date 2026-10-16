import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError, createMeituanApi, normalizeProducts, checkResponse, validCoordinate, distanceKm } from '../lib.mjs';
import { createAuth } from '../auth.mjs';

test('搜索在未登录时不发送任何上游请求', async () => {
  let requests = 0;
  const api = createMeituanApi(async () => { requests++; }, () => '');
  await assert.rejects(api.search({ keyword: '火锅', lat: '31.2', lng: '121.4', cityId: '1' }), error => error.code === 'LOGIN_REQUIRED');
  assert.equal(requests, 0);
});

test('搜索保持原接口参数和翻页标识，只输出白名单商品字段', async () => {
  let sent;
  const api = createMeituanApi(async (url, options) => {
    sent = { url, ...options };
    return { status: 200, data: { code: 200, success: true, data: { productList: [{ productId: '123', poiId: '456', productName: '测试套餐', salePrice: '19.90', distanceText: '800m', token: 'must-not-escape' }], queryId: 'q-next', requestId: 'r-next', isLastPage: false } } };
  }, () => 'test-only-token');
  const result = await api.search({ keyword: '火锅', lat: '31.2', lng: '121.4', cityId: '1', page: 2, queryId: 'q-prev', requestId: 'r-prev', radius: 8 });
  assert.equal(sent.url, 'https://click.meituan.com/cps/ai/product/searchProductByAgent');
  assert.equal(sent.body.userParamDTO.token, 'test-only-token');
  assert.equal(sent.token, 'test-only-token');
  assert.equal(sent.body.userParamDTO.app, 216);
  assert.equal(sent.body.queryId, 'q-prev');
  assert.equal(sent.body.requestId, 'r-prev');
  assert.equal(result.products[0].salePrice, 19.9);
  assert.equal(result.queryId, 'q-next');
  assert.equal(result.products[0].token, undefined);
  assert.equal(JSON.stringify(result).includes('test-only-token'), false);
});

test('距离支持米、公里和中文单位；缺失距离不误删', () => {
  assert.equal(distanceKm('800m'), .8);
  assert.equal(distanceKm('3.5km'), 3.5);
  assert.equal(distanceKm('2公里'), 2);
  const result = normalizeProducts([{ distanceText: '9km' }, { distanceText: '350m' }, { distanceText: '' }], 8);
  assert.equal(result.length, 2);
});

test('图片禁用可执行 URL，价格缺失不显示为零元', () => {
  const [item] = normalizeProducts([{ imageUrl: 'javascript:alert(1)', salePrice: null }], 8);
  assert.equal(item.imageUrl, '');
  assert.equal(item.salePrice, null);
  assert.equal(validCoordinate(null, null), false);
  assert.equal(validCoordinate('91', '121'), false);
});

test('HTTP 403 不被武断解释为 IP 封禁；登录错误可触发失效处理', () => {
  assert.throws(() => checkResponse(null, 403), error => error.code === 'UPSTREAM_FORBIDDEN' && /签名/.test(error.message));
  assert.throws(() => checkResponse({ code: 401, message: 'token expired' }, 200), error => error.code === 'AUTH_EXPIRED' && error.status === 401);
});

test('无效参数与不完整商品响应不会伪装成搜索成功', async () => {
  let count = 0;
  const api = createMeituanApi(async () => { count++; return { status: 200, data: { code: 200, success: true, data: {} } }; }, () => 'test-only-token');
  await assert.rejects(api.search({ keyword: '火锅', lat: 91, lng: 120, cityId: 1 }), error => error.code === 'INVALID_LOCATION');
  assert.equal(count, 0);
  await assert.rejects(api.search({ keyword: '火锅', lat: 31, lng: 120, cityId: 1 }), error => error.code === 'INVALID_PRODUCTS');
});

test('扫码授权的校验对、轮询和本地持久化形成闭环，前端状态不含 Token', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'meituan-web-test-'));
  const calls = [];
  const request = async url => {
    const parsed = new URL(url);
    calls.push(parsed);
    return { status: 200, data: { code: 0, data: parsed.pathname.endsWith('/code') ? { authCode: 'test-code', shortLink: 'https://passport.meituan.com/test-only-link' } : { authStatus: 4, token: 'test-only-secret' } } };
  };
  const auth = createAuth(request, temporary);
  try {
    const status = await auth.start(async () => 'https://img.meituan.net/test-only-qr.png');
    assert.equal(status.login.status, 'waiting');
    assert.equal(status.login.authCode, undefined);
    assert.equal(status.login.verifier, undefined);
    await new Promise(resolve => setTimeout(resolve, 950));
    assert.equal(auth.getToken(), 'test-only-secret');
    assert.equal(auth.state().authenticated, true);
    assert.equal(auth.state().verified, false);
    assert.equal(JSON.stringify(auth.state()).includes('test-only-secret'), false);
    const { createHash } = await import('node:crypto');
    assert.equal(calls[0].searchParams.get('code_challenge'), createHash('sha256').update(calls[1].searchParams.get('code_verifier')).digest('hex'));
    assert.equal(fs.statSync(path.join(temporary, 'credentials.json')).mode & 0o777, 0o600);
    auth.markVerified();
    assert.equal(auth.state().verified, true);
    auth.invalidate();
    assert.equal(fs.existsSync(path.join(temporary, 'credentials.json')), false);
  } finally { auth.close(); fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('服务端错误文案被裁短，调用方无需获得原始响应', () => {
  assert.throws(() => checkResponse({ code: 500, message: 'error token=secret-value' }, 200), error => error instanceof AppError && !error.message.includes('secret-value'));
});
