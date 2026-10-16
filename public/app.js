const $ = selector => document.querySelector(selector);
const state = { auth: null, location: null, products: [], activeQuery: null, page: 0, queryId: '', requestId: '', isLastPage: true, busy: false, poll: null, loggingIn: false };

async function api(path, body, timeout = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      const error = new Error(result.error?.message || '请求没有完成，请重试');
      error.code = result.error?.code;
      throw error;
    }
    return result.data ?? result;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('请求用时较长，请稍后重试');
    if (error instanceof TypeError) throw new Error('暂时无法连接本地服务，请确认服务仍在运行');
    throw error;
  } finally { clearTimeout(timer); }
}

function feedback(message, info = false) {
  $('#feedback-message').textContent = message;
  $('#feedback').classList.toggle('info', info);
  $('#feedback').hidden = false;
}
function handleError(error) {
  feedback(error.message);
  if (['AUTH_EXPIRED', 'LOGIN_REQUIRED'].includes(error.code)) refreshStatus();
}
function setBusy(value, message = '正在搜索附近团购…') {
  state.busy = value;
  $('#search-button').disabled = value;
  $('#load-more').disabled = value;
  $('#recent-location').disabled = value;
  $('#search-button').textContent = value ? '正在查找…' : '发现团购 →';
  $('#loading-message').textContent = message;
  $('#loading-state').hidden = !value;
  $('.results-section').setAttribute('aria-busy', String(value));
}
function setLocation(location) {
  state.location = location;
  $('#address').value = location.address;
  $('#location-text').textContent = location.address;
  $('#location-summary').hidden = false;
  $('#step-location').classList.add('done');
}
function renderAuth(data) {
  const wasAuthenticated = state.auth?.authenticated;
  state.auth = data;
  const waiting = data.login?.status === 'waiting';
  const queryUnavailable = data.lastSearch?.httpStatus === 403;
  const badge = $('#account-badge');
  badge.classList.toggle('connected', data.authenticated && !queryUnavailable);
  badge.lastElementChild.textContent = data.authenticated ? (queryUnavailable ? '已登录 · 查询暂不可用' : data.verified ? '已登录 · 连接已验证' : '已登录 · 待搜索验证') : waiting ? '等待扫码' : '尚未登录';
  $('#account-title').textContent = data.authenticated ? '美团账号已连接' : '连接美团账号';
  $('#account-description').textContent = data.authenticated ? '选好位置，就能开始查找团购' : '扫码一次，开始发现附近美味';
  $('#login-button').hidden = data.authenticated;
  $('#login-button').disabled = waiting || state.loggingIn;
  $('#login-button').textContent = waiting ? '等待美团 App 确认…' : state.loggingIn ? '正在获取登录链接…' : data.login?.status === 'expired' || data.login?.status === 'failed' ? '重新扫码登录 ↗' : '扫码登录美团 ↗';
  $('#logout-button').hidden = !data.authenticated;
  $('#login-panel').hidden = !data.login || data.login.status === 'success';
  $('#step-login').classList.toggle('done', data.authenticated);
  const qr = $('#login-qr');
  if (waiting && data.login.qrImage) {
    if (qr.getAttribute('src') !== data.login.qrImage) qr.src = data.login.qrImage;
    $('#qr-wrapper').hidden = false;
  } else $('#qr-wrapper').hidden = true;
  if (waiting && data.login.authUrl) {
    $('#auth-link').href = data.login.authUrl;
    $('#auth-link').hidden = false;
  } else { $('#auth-link').hidden = true; $('#auth-link').removeAttribute('href'); }
  $('#login-message').textContent = data.login?.message || (data.login?.qrImage ? '请用美团 App 扫码确认登录' : '二维码准备中，也可以打开下方授权链接');
  if (waiting) {
    const remaining = Math.max(0, Math.ceil((data.login.expiresAt - Date.now()) / 1000));
    $('#login-countdown').textContent = `链接剩余 ${Math.floor(remaining / 60)} 分 ${remaining % 60} 秒 · 授权后自动继续`;
  } else $('#login-countdown').textContent = '';
  if (data.authenticated && wasAuthenticated === false) feedback('登录成功。输入城市和地址，开始搜索附近团购。', true);
  const service = data.service;
  if (service) {
    $('#connection-text').textContent = service.status === 'connected' ? '美团接口已连接' : service.status === 'error' ? '接口连接需检查' : '美团连接待验证';
    $('#connection-dot').style.background = service.status === 'connected' ? '#74926d' : service.status === 'error' ? '#e58c60' : '#b4b6ab';
    $('.connection-line').title = service.message || '';
  }
  if (state.poll) clearTimeout(state.poll);
  if (waiting) state.poll = setTimeout(refreshStatus, 2000);
}
async function refreshStatus() {
  try { renderAuth(await api('/api/status', undefined, 6000)); }
  catch (error) {
    $('#connection-text').textContent = '本地服务连接中断';
    if (state.auth?.login?.status === 'waiting') state.poll = setTimeout(refreshStatus, 4000);
  }
}
async function startLogin() {
  if (state.loggingIn) return;
  state.loggingIn = true;
  $('#login-button').disabled = true;
  $('#login-button').textContent = '正在获取登录链接…';
  $('#feedback').hidden = true;
  try { renderAuth(await api('/api/auth/start', {})); }
  catch (error) { handleError(error); }
  finally { state.loggingIn = false; await refreshStatus(); }
}

function priceText(value) {
  if (value == null) return '—';
  return Number(value).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}
function renderProducts() {
  const grid = $('#product-grid');
  grid.replaceChildren();
  for (const product of state.products) {
    const card = $('#product-template').content.cloneNode(true);
    const image = card.querySelector('.product-image');
    const fallback = card.querySelector('.image-fallback');
    image.alt = product.productName;
    image.addEventListener('error', () => { image.hidden = true; fallback.hidden = false; }, { once: true });
    if (product.imageUrl) image.src = product.imageUrl;
    else { image.hidden = true; fallback.hidden = false; }
    card.querySelector('.distance-pill').textContent = product.distanceText || '距离待确认';
    card.querySelector('.shop-name').textContent = product.poiName;
    card.querySelector('.shop-name').title = product.poiName;
    const score = card.querySelector('.score');
    score.textContent = product.score ? `★ ${product.score}` : '';
    score.hidden = !product.score;
    card.querySelector('.product-title').textContent = product.productName;
    card.querySelector('.product-title').title = product.productName;
    card.querySelector('.price strong').textContent = priceText(product.salePrice);
    if (product.salePrice === null) { card.querySelector('.currency').hidden = true; card.querySelector('.price-caption').textContent = '价格待确认'; }
    grid.appendChild(card);
  }
  grid.hidden = state.products.length === 0;
  $('#empty-state').hidden = state.products.length > 0;
  $('#result-count').hidden = !state.activeQuery;
  $('#result-count').textContent = `${state.products.length} 款`;
  if (state.activeQuery) {
    $('#result-description').textContent = `「${state.activeQuery.keyword}」 · ${state.activeQuery.address} · ${state.activeQuery.radius} 公里内`;
    $('#empty-title').textContent = '这次还没有找到合适的团购';
    $('#empty-description').textContent = '可以换个关键词、扩大搜索范围，或继续查看下一页。';
  }
  $('#pagination').hidden = !state.activeQuery;
  $('#page-description').textContent = state.isLastPage ? `已浏览 ${state.products.length} 款团购，当前搜索已到末页` : `已浏览 ${state.page} 页 · ${state.products.length} 款团购`;
  $('#load-more').hidden = state.isLastPage;
  $('#step-browse').classList.toggle('done', state.products.length > 0);
}

async function search(append = false) {
  if (state.busy) return;
  if (!state.auth?.authenticated) {
    feedback('先连接美团账号，再开始查找附近团购。');
    $('#login-button').focus();
    return;
  }
  if (!append && !$('#search-form').reportValidity()) return;
  const keyword = append ? state.activeQuery.keyword : $('#keyword').value.trim();
  const address = append ? state.activeQuery.address : $('#address').value.trim();
  const radius = append ? state.activeQuery.radius : Number($('#radius').value);
  const oldEmpty = $('#empty-state').hidden;
  setBusy(true, '正在确认位置并查找附近团购…');
  $('#feedback').hidden = true;
  if (!state.products.length) $('#empty-state').hidden = true;
  try {
    const location = append ? state.activeQuery : state.location?.address === address ? state.location : await api('/api/location/address', { address });
    if (!append) setLocation(location);
    const activeQuery = { keyword, address: location.address, radius, lat: location.lat, lng: location.lng, cityId: location.cityId };
    const result = await api('/api/search', { ...activeQuery, page: append ? state.page + 1 : 1, ...(append ? { queryId: state.queryId, requestId: state.requestId } : {}) });
    if (!append) { state.products = []; state.activeQuery = activeQuery; }
    const known = new Set(state.products.map(p => `${p.productId}|${p.poiId}`));
    for (const product of result.products) {
      const key = `${product.productId}|${product.poiId}`;
      if (!known.has(key)) { state.products.push(product); known.add(key); }
    }
    state.page = result.page;
    state.queryId = result.queryId;
    state.requestId = result.requestId;
    state.isLastPage = result.isLastPage;
    renderProducts();
    if (result.products.length === 0 && result.rawCount > 0) feedback('这一页的团购超出了所选距离范围，可以扩大范围或查看下一页。', true);
    else if (result.products.length === 0 && !result.isLastPage) feedback('这一页暂时没有团购，可以继续查看下一页。', true);
  } catch (error) {
    $('#empty-state').hidden = state.products.length > 0 ? true : oldEmpty;
    handleError(error);
  } finally { setBusy(false); await refreshStatus(); }
}

$('#login-button').addEventListener('click', startLogin);
$('#login-qr').addEventListener('error', () => { $('#qr-wrapper').hidden = true; $('#login-message').textContent = '二维码图片暂时无法显示，请打开下方授权链接'; });
$('#logout-button').addEventListener('click', async () => {
  $('#logout-button').disabled = true;
  try {
    renderAuth(await api('/api/auth/logout', {}));
    state.products = []; state.activeQuery = null; state.location = null;
    state.page = 0; state.isLastPage = true;
    $('#location-summary').hidden = true;
    $('#address').value = '';
    $('#step-location').classList.remove('done');
    $('#result-description').textContent = '从一份心动的团购开始';
    $('#empty-title').textContent = '附近的美味，等你发现';
    $('#empty-description').textContent = '登录美团，选好位置，就能浏览真实团购。';
    renderProducts();
    feedback('已清除这个网页保存的登录凭证。', true);
  } catch (error) { handleError(error); }
  finally { $('#logout-button').disabled = false; }
});
$('#search-form').addEventListener('submit', event => { event.preventDefault(); search(); });
$('#load-more').addEventListener('click', () => search(true));
$('#feedback-dismiss').addEventListener('click', () => { $('#feedback').hidden = true; });
$('#address').addEventListener('input', () => {
  state.location = null;
  $('#location-summary').hidden = true;
  $('#step-location').classList.remove('done');
});
document.querySelectorAll('[data-keyword]').forEach(button => button.addEventListener('click', () => {
  $('#keyword').value = button.dataset.keyword;
  document.querySelectorAll('[data-keyword]').forEach(other => other.classList.toggle('active', other === button));
}));
$('#keyword').addEventListener('input', () => document.querySelectorAll('[data-keyword]').forEach(button => button.classList.toggle('active', button.dataset.keyword === $('#keyword').value)));
$('#recent-location').addEventListener('click', async () => {
  if (!state.auth?.authenticated) { feedback('请先扫码登录，再选择使用美团最近位置。'); $('#login-button').focus(); return; }
  $('#recent-location').disabled = true;
  $('#recent-location').textContent = '正在获取位置…';
  try { setLocation(await api('/api/location/recent', {})); feedback('已使用你最近一次在美团服务中的位置，可以修改后再搜索。', true); }
  catch (error) { handleError(error); }
  finally { $('#recent-location').disabled = false; $('#recent-location').textContent = '使用美团最近位置'; await refreshStatus(); }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshStatus(); });
refreshStatus();
