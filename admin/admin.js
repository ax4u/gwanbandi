(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const put = (node, value) => { if (node.textContent !== String(value)) node.textContent = String(value); };
  const labels = { pending: '승인 대기', visible: '상영 허용 · 동의 조건 적용', hidden: '숨김' };
  let authenticated = false;
  let state = null;
  let filter = 'all';
  let timer;
  let polling = false;
  let busy = false;
  let generation = 0;
  let settingsDirty = false;
  const cards = new Map();

  async function request(path, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch('/control/api/' + path, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Jungang-Admin': '1' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const error = new Error('request failed');
        error.status = response.status;
        throw error;
      }
      if (!data || typeof data !== 'object') throw new Error('invalid response');
      return data;
    } finally { clearTimeout(timeout); }
  }

  function message(id, text, error = false) {
    put($(id), text);
    $(id).classList.toggle('error', error);
  }

  function connection(ok, text) {
    $('admin-connection').dataset.connected = String(ok);
    put($('admin-connection'), text);
  }

  function validateState(data) {
    if (typeof data.paused !== 'boolean' || typeof data.approval !== 'boolean' || !Array.isArray(data.memories)) throw new Error('invalid state');
    if (data.memories.some((item) => !item || !['string', 'number'].includes(typeof item.id) || typeof item.text !== 'string' || typeof item.nickname !== 'string' || !Object.hasOwn(labels, item.status))) throw new Error('invalid memory');
    return { ...data, memories: [...data.memories].sort((a, b) => (new Date(b.createdAt).getTime() || 0) - (new Date(a.createdAt).getTime() || 0)) };
  }

  function showLogin(text, error = false) {
    authenticated = false;
    state = null;
    settingsDirty = false;
    generation++;
    clearTimeout(timer);
    $('dashboard').hidden = true;
    $('logout').hidden = true;
    $('login-panel').hidden = false;
    $('admin-memories').replaceChildren();
    cards.clear();
    $('admin-key').value = '';
    message('login-message', text, error);
  }

  function showDashboard(focus = false) {
    authenticated = true;
    $('login-panel').hidden = true;
    $('dashboard').hidden = false;
    $('logout').hidden = false;
    if (focus) $('dashboard-title').focus();
  }

  function schedule() {
    clearTimeout(timer);
    if (authenticated) timer = setTimeout(refresh, document.hidden ? 5000 : 1500);
  }

  function updateControls() {
    $('login-button').disabled = busy;
    $('admin-key').disabled = busy;
    $('logout').disabled = busy;
    $('refresh').disabled = busy;
    $('setting-paused').disabled = busy;
    $('setting-approval').disabled = busy;
    $('save-settings').disabled = busy || !settingsDirty || !state;
    for (const card of cards.values()) card.querySelectorAll('button').forEach((button) => { button.disabled = busy; });
  }

  function createCard(id) {
    const card = document.createElement('article');
    card.className = 'admin-card';
    card.dataset.id = id;
    const content = document.createElement('div');
    const meta = document.createElement('div');
    meta.className = 'admin-card-meta';
    const badge = document.createElement('span');
    badge.className = 'status-badge';
    const author = document.createElement('span');
    author.className = 'admin-author';
    const time = document.createElement('time');
    meta.append(badge, author, time);
    content.append(meta, document.createElement('blockquote'));
    const scope = document.createElement('p'); scope.className = 'consent-scope'; content.append(scope);
    const actions = document.createElement('div');
    actions.className = 'admin-card-actions';
    for (const status of ['visible', 'hidden']) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button ' + (status === 'visible' ? 'primary' : 'danger');
      button.dataset.action = status;
      actions.append(button);
    }
    card.append(content, actions);
    return card;
  }

  function render() {
    if (!state) return;
    if (!settingsDirty) {
      $('setting-paused').checked = state.paused;
      $('setting-approval').checked = state.approval;
      message('settings-message', `현재: ${state.paused ? '상영 일시정지' : '자동 상영'} · 이전 승인 설정 ${state.approval ? 'ON' : 'OFF'} (보존용) · 새 동의 글은 이 값과 관계없이 접수 후 상영 가능`);
    }
    const counts = { all: state.memories.length, pending: 0, visible: 0, hidden: 0 };
    for (const memory of state.memories) counts[memory.status]++;
    for (const [key, value] of Object.entries(counts)) put($('count-' + key), value);
    const memories = state.memories.filter((item) => filter === 'all' || item.status === filter);
    const visibleIds = new Set(memories.map((item) => String(item.id)));
    const focusedCard = document.activeElement?.closest('.admin-card');
    const focusRemoved = focusedCard && !visibleIds.has(focusedCard.dataset.id);
    for (const [id, card] of cards) {
      if (!visibleIds.has(id)) { card.remove(); cards.delete(id); }
    }
    memories.forEach((memory, index) => {
      const id = String(memory.id);
      let card = cards.get(id);
      if (!card) { card = createCard(id); cards.set(id, card); }
      card.dataset.status = memory.status;
      put(card.querySelector('.status-badge'), labels[memory.status]);
      put(card.querySelector('.admin-author'), memory.nickname || '익명의 관객');
      put(card.querySelector('blockquote'), memory.text);
      put(card.querySelector('.consent-scope'), memory.publicScope);
      const time = card.querySelector('time');
      const date = new Date(memory.createdAt);
      if (!Number.isNaN(date.getTime())) {
        time.dateTime = date.toISOString();
        put(time, new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date));
      } else { time.removeAttribute('datetime'); put(time, '접수 시각 확인 불가'); }
      const publish = card.querySelector('[data-action=visible]');
      const hide = card.querySelector('[data-action=hidden]');
      publish.hidden = memory.status === 'visible';
      hide.hidden = memory.status === 'hidden';
      put(publish, memory.status === 'pending' ? '승인하고 공개' : '다시 공개');
      put(hide, '숨기기');
      publish.setAttribute('aria-label', `${memory.nickname || '익명의 관객'}의 추억 ${memory.status === 'pending' ? '승인하고 공개' : '다시 공개'}`);
      hide.setAttribute('aria-label', `${memory.nickname || '익명의 관객'}의 추억 숨기기`);
      const position = $('admin-memories').children[index];
      if (position !== card) $('admin-memories').insertBefore(card, position || null);
    });
    $('admin-empty').hidden = memories.length > 0;
    put($('admin-empty').querySelector('h4'), filter === 'all' ? '아직 접수된 추억이 없습니다.' : `${labels[filter]} 상태의 추억이 없습니다.`);
    if (focusRemoved) document.querySelector(`[data-filter="${filter}"]`).focus();
    updateControls();
  }

  async function refresh(initial = false) {
    if (polling || busy) return;
    clearTimeout(timer);
    polling = true;
    const version = generation;
    try {
      const data = validateState(await request('state'));
      if (version !== generation) return;
      state = data;
      showDashboard();
      connection(true, '연결됨 · 자동 새로고침');
      render();
    } catch (error) {
      if (version !== generation) return;
      if (error.status === 401) showLogin(initial === true ? '관리 키를 입력해 주세요.' : '로그인이 만료됐습니다. 관리 키로 다시 로그인해 주세요.', initial !== true);
      else if (authenticated) connection(false, navigator.onLine === false ? '오프라인 · 표시 내용은 마지막 수신 상태' : '연결 지연 · 마지막 수신 상태 / 자동 재시도');
      else message('login-message', '운영 서버에 연결하지 못했습니다. SSH 터널과 주소를 확인하고 로그인해 주세요.', true);
    } finally { polling = false; updateControls(); schedule(); }
  }

  async function mutation(path, payload, messageId, check) {
    if (busy || !authenticated) return;
    busy = true;
    generation++;
    clearTimeout(timer);
    updateControls();
    message(messageId, '저장하고 서버 상태를 확인하고 있습니다.');
    try {
      await request(path, payload);
      state = validateState(await request('state'));
      if (!check(state)) { render(); throw new Error('readback mismatch'); }
      if (path === 'settings') settingsDirty = false;
      render();
      connection(true, '연결됨 · 변경 확인 완료');
      message(messageId, path === 'settings' ? '설정을 저장하고 적용 상태를 확인했습니다.' : payload.status === 'hidden' ? '숨김 처리와 서버 반영을 확인했습니다.' : '공개 처리와 서버 반영을 확인했습니다.');
    } catch (error) {
      if (error.status === 401) showLogin('로그인이 만료됐습니다. 변경 결과를 다시 로그인한 뒤 확인해 주세요.', true);
      else {
        connection(false, '변경 결과 재확인 필요');
        message(messageId, error.status === 403 ? '이 주소에서는 변경할 수 없습니다. SSH 로컬 운영 주소를 확인해 주세요.' : '변경 결과를 확인하지 못했습니다. 새로고침으로 현재 상태를 확인한 뒤 다시 시도해 주세요.', true);
      }
    } finally { busy = false; updateControls(); schedule(); }
  }

  $('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || authenticated || !$('admin-key').value) return;
    busy = true;
    generation++;
    clearTimeout(timer);
    const key = $('admin-key').value;
    $('admin-key').value = '';
    updateControls();
    message('login-message', '관리 키를 확인하고 있습니다.');
    try {
      const result = await request('login', { key });
      if (result.ok !== true) throw new Error('login failed');
      // A successful login response is not enough: verify the scoped session.
      state = validateState(await request('state'));
      settingsDirty = false;
      showDashboard(true);
      connection(true, '연결됨 · 비공개 세션 확인');
      render();
    } catch (error) {
      showLogin(error.status === 429 ? '로그인 시도가 많습니다. 잠시 기다렸다 다시 시도해 주세요.' : [401, 403].includes(error.status) ? '관리 키 또는 접속 주소를 확인해 주세요. 키는 서버에서 안전하게 전달받아야 합니다.' : '로그인을 확인하지 못했습니다. SSH 연결과 브라우저의 쿠키 허용 상태를 확인해 주세요.', true);
    } finally { busy = false; updateControls(); schedule(); if (!authenticated) $('admin-key').focus(); }
  });

  $('logout').addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    generation++;
    clearTimeout(timer);
    // Hide private content immediately, even when the network is unavailable.
    showLogin('로그아웃하고 세션 종료를 확인하고 있습니다.');
    updateControls();
    try {
      await request('logout', {});
      try {
        await request('state');
        message('login-message', '세션이 아직 유효합니다. 서버 연결을 확인하고 브라우저를 닫아 주세요.', true);
      } catch (error) {
        if (error.status !== 401) throw error;
        message('login-message', '로그아웃했습니다. 비공개 세션 종료를 확인했습니다.');
      }
    } catch { message('login-message', '로그아웃 결과를 확인하지 못했습니다. 안전을 위해 브라우저를 닫고 SSH 터널을 종료해 주세요.', true); }
    finally { busy = false; updateControls(); $('admin-key').focus(); }
  });

  $('settings-form').addEventListener('change', () => {
    if (!state || busy) return;
    settingsDirty = $('setting-paused').checked !== state.paused || $('setting-approval').checked !== state.approval;
    message('settings-message', settingsDirty ? '아직 저장하지 않은 변경이 있습니다. 설정 저장을 눌러 적용하세요.' : '서버에 저장된 설정과 같습니다.');
    updateControls();
  });
  $('settings-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!settingsDirty) return;
    const payload = { paused: $('setting-paused').checked, approval: $('setting-approval').checked };
    mutation('settings', payload, 'settings-message', (data) => data.paused === payload.paused && data.approval === payload.approval);
  });
  document.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => {
    filter = button.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
    render();
  }));
  $('admin-memories').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button || busy || !state) return;
    const card = button.closest('.admin-card');
    const memory = state.memories.find((item) => String(item.id) === card.dataset.id);
    if (!memory) return;
    const status = button.dataset.action;
    mutation('moderate', { id: memory.id, status }, 'moderation-message', (data) => data.memories.find((item) => String(item.id) === String(memory.id))?.status === status);
  });
  $('refresh').addEventListener('click', () => refresh());
  window.addEventListener('online', () => { if (authenticated) refresh(); });
  window.addEventListener('offline', () => { if (authenticated) connection(false, '오프라인 · 표시 내용은 마지막 수신 상태'); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && authenticated) refresh(); });
  refresh(true);
})();
