import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { AppError, createTransport, createMeituanApi, normalizeProducts, checkResponse, validCoordinate, distanceKm } from '../lib.mjs';
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
  assert.throws(() => checkResponse(null, 403), error => error.code === 'UPSTREAM_FORBIDDEN' && !/IP|封禁/.test(error.message));
  assert.throws(() => checkResponse({ code: 401, message: 'token expired' }, 200), error => error.code === 'AUTH_EXPIRED' && error.status === 401);
});

function mockHttps(raw, responseHeaders, observe) {
  return (url, options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.end = payload => {
      observe?.({ url, options, payload });
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = 200;
        response.headers = responseHeaders;
        callback(response);
        response.emit('data', Buffer.from(raw));
        response.emit('end');
      });
    };
    return request;
  };
}

test('HTTP 传输按实际 UTF-8 字节签名，业务请求头与原封装保持一致', async () => {
  let sent, signArgs;
  const records = [];
  const guard = {
    addCommonParams: url => ({ url: url + '?csecplatform=7&csecversion=1.3.1' }),
    signRequest: (...args) => { signArgs = args; return { mtgsig: 'test-only-signature' }; }
  };
  const request = createTransport(guard, 100, {
    requestImpl: mockHttps('{"code":200,"data":{"token":"response-only-secret"}}', { 'content-type': 'application/json; charset=utf-8', date: new Date().toUTCString(), 'set-cookie': 'private-cookie', 'x-forbid-code': 'private-reference' }, value => { sent = value; }),
    onResponse: record => records.push(record)
  });
  const body = { keyword: '火'.repeat(6000), token: 'request-only-secret' };
  await request('https://click.meituan.com/cps/ai/product/searchProductByAgent', { body, token: 'header-only-secret' });
  const bytes = Buffer.from(JSON.stringify(body));
  assert.equal(sent.payload.toString(), bytes.toString());
  assert.equal(sent.options.headers['Content-Length'], bytes.length);
  assert.equal(sent.options.headers.Accept, undefined);
  assert.equal(sent.options.headers['User-Agent'], undefined);
  assert.equal(sent.options.headers['X-Requested-With'], 'XMLHttpRequest');
  assert.deepEqual(signArgs, ['POST', sent.url, crypto.createHash('md5').update(bytes.subarray(0, 16200)).digest('hex')]);
  const diagnosticText = JSON.stringify(records);
  for (const secret of ['request-only-secret', 'response-only-secret', 'header-only-secret', 'test-only-signature', 'private-cookie', 'private-reference']) assert.equal(diagnosticText.includes(secret), false);
  assert.equal(records[0].path, '/cps/ai/product/searchProductByAgent');
  assert.equal(records[0].responseKind, 'json');
  assert.equal(records[0].hasForbidCode, true);
});

test('Passport 显式请求头仍可传递，诊断写入失败不影响真实响应', async () => {
  let sent;
  const guard = { addCommonParams: url => ({ url }), signRequest: () => ({ mtgsig: 'test-only-signature' }) };
  const request = createTransport(guard, 100, {
    requestImpl: mockHttps('{"code":0}', {}, value => { sent = value; }),
    onResponse: () => { throw new Error('disk write failed'); }
  });
  const result = await request('https://passport.meituan.com/api/account/userauth/check?token=query-only-secret', { method: 'GET', headers: { Accept: 'application/json, */*', 'User-Agent': 'Passport-test' } });
  assert.equal(sent.options.headers['User-Agent'], 'Passport-test');
  assert.equal(sent.options.headers.Accept, 'application/json, */*');
  assert.equal(result.data.code, 0);
  assert.equal(JSON.stringify(result.diagnostics).includes('query-only-secret'), false);
});

test('保留超过 300 字符的合法分页游标，拒绝超长输入而不截断', async () => {
  const cursor = 'cursor'.repeat(80);
  let sent, calls = 0;
  const api = createMeituanApi(async (url, options) => { calls++; sent = options.body; return { status: 200, data: { code: 200, success: true, data: { productList: [], isLastPage: true } } }; }, () => 'test-only-token');
  const input = { keyword: '火锅', lat: 31, lng: 120, cityId: 1, page: 2, queryId: cursor, requestId: cursor };
  await api.search(input);
  assert.equal(sent.queryId, cursor);
  assert.equal(sent.requestId, cursor);
  await assert.rejects(api.search({ ...input, queryId: 'x'.repeat(2049) }), error => error.code === 'INVALID_CURSOR');
  assert.equal(calls, 1);
});

test('搜索遇到上游 403 时保留诊断，且不自动重试或误判 Token 失效', async () => {
  let calls = 0;
  const diagnostic = { httpStatus: 403, responseKind: 'html' };
  const api = createMeituanApi(async () => { calls++; return { status: 403, data: null, diagnostics: diagnostic }; }, () => 'test-only-token');
  await assert.rejects(api.search({ keyword: '火锅', lat: 31, lng: 120, cityId: 1 }), error => error.code === 'UPSTREAM_FORBIDDEN' && error.diagnostics === diagnostic);
  assert.equal(calls, 1);
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
