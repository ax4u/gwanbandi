(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const base = '/jungang-memory/manage/api/';
  const fields = ['eventName', 'participationGuide', 'inputExample', 'waitingText', 'background', 'fontSize', 'intervalSeconds'];
  const scenes = new Set(['auto', 'marquee', 'screen', 'street', 'blossom']);
  const fonts = new Set(['small', 'normal', 'large']);
  const labels = { pending: '대기', visible: '상영 가능', hidden: '상영 불가' };
  const drafts = new Map();
  let state = null, busy = false, locked = false, preview = null, appliedApproval = null, filter = 'all', timer, epoch = 0;
  const put = (node, value) => { if (node.textContent !== String(value)) node.textContent = String(value); };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const configCopy = (config) => Object.fromEntries(fields.map((key) => [key, config[key]]));
  const getConfig = () => Object.fromEntries(fields.map((key) => [key, key === 'intervalSeconds' ? (/^[1-9][0-9]*$/.test($(key).value) ? Number($(key).value) : null) : $(key).value]));
  const dirtyConfig = () => state && !same(getConfig(), configCopy(state.config));
  const dirty = () => dirtyConfig() || drafts.size > 0 || preview !== null || (state && ($('paused').checked !== state.paused || $('approval').checked !== state.approval));
  const stamp = (s) => JSON.stringify([s.version, s.revision, s.session, s.history.map((h) => h.id), s.memories.map((m) => [m.id, m.version, m.status, m.session])]);
  function message(id, text, error = false) { put($(id), text); $(id).classList.toggle('error', error); }
  function node(tag, className, text) { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; }
  function date(value) { const d = new Date(value); return Number.isNaN(d.getTime()) ? '시각 확인 불가' : new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(d); }

  async function request(path, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { Accept: 'application/json', 'X-Jungang-Client': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) { const error = new Error('request failed'); error.status = response.status; throw error; }
      const data = await response.json();
      if (!data || typeof data !== 'object') throw new Error('invalid response');
      return data;
    } finally { clearTimeout(timeout); }
  }
  function validConfig(c) {
    return c && ['eventName', 'participationGuide', 'inputExample', 'waitingText'].every((k) => typeof c[k] === 'string') && scenes.has(c.background) && fonts.has(c.fontSize) && Number.isInteger(c.intervalSeconds) && c.intervalSeconds >= 1 && c.intervalSeconds <= 60;
  }
  function validateState(s) {
    if (s.eventId !== 'jungang-memory' || !Number.isSafeInteger(s.version) || !Number.isSafeInteger(s.revision) || !validConfig(s.config) || typeof s.paused !== 'boolean' || typeof s.approval !== 'boolean' || !Array.isArray(s.history) || !Array.isArray(s.memories)) throw new Error('invalid state');
    if (s.memories.some((m) => !Number.isSafeInteger(m.id) || !Number.isSafeInteger(m.version) || ![null, 1, 2].includes(m.session) || typeof m.text !== 'string' || typeof m.nickname !== 'string' || !(m.displayText === null || typeof m.displayText === 'string') || !Object.hasOwn(labels, m.status) || !Array.isArray(m.history))) throw new Error('invalid memory');
    return s;
  }
  const readState = async () => validateState(await request('state'));
  function fillConfig(config) { fields.forEach((key) => { if ($(key).value !== String(config[key])) $(key).value = config[key]; }); }
  function invalidatePreview(text = '내용이 바뀌었습니다. 비공개 미리보기를 다시 확인해 주세요.') {
    preview = null; $('config-preview').hidden = true;
    for (const id of ['preview-name', 'preview-guide', 'preview-example', 'preview-waiting', 'preview-timing']) put($(id), '');
    message('config-message', text); controls();
  }
  function controls() {
    const off = busy || locked || !state;
    put($('approval-current'), appliedApproval === null ? '' : `보존된 이전 승인 설정: ${appliedApproval ? 'ON' : 'OFF'} · 새 동의 글은 이 값과 관계없이 접수 후 상영 가능`);
    $('approval-draft').hidden = !state || $('approval').checked === appliedApproval;
    put($('approval-draft'), state && $('approval').checked !== appliedApproval ? `아직 미저장인 이전 승인 설정: ${$('approval').checked ? 'ON' : 'OFF'} · 아래 버튼은 값만 저장하며 신규 자동 공개·기존 글 상태는 바꾸지 않습니다.` : '');
    $('login-button').disabled = busy; $('username').disabled = busy; $('password').disabled = busy;
    $('logout').disabled = busy; $('refresh').disabled = busy;
    $('config-fields').disabled = off; $('settings-fields').disabled = off;
    $('preview-config').disabled = off; $('discard-config').disabled = off;
    $('publish-config').disabled = off || !preview || preview.version !== state?.version || !same(getConfig(), preview.config);
    $('config-history').disabled = off || !state?.history.length;
    $('restore-config').disabled = off || !$('config-history').value;
    $('save-settings').disabled = off || ($('paused').checked === state.paused && $('approval').checked === state.approval);
    for (const card of $('memory-list').children) {
      const m = state?.memories.find((item) => String(item.id) === card.dataset.id), d = drafts.get(m?.id);
      card.querySelectorAll('button,textarea,select').forEach((el) => { el.disabled = off; });
      card.querySelector('[data-action=publish]').disabled = off || !d?.preview || d.version !== m?.version || !same(d.text, d.preview.text);
      card.querySelector('[data-action=restore]').disabled = off || !card.querySelector('.memory-history').value;
      card.querySelector('.memory-history').disabled = off || !m?.history.length;
    }
  }
  function histories(select, history) {
    select.replaceChildren(new Option(history.length ? '이전 기록을 선택하세요' : '아직 이전 기록이 없습니다', ''));
    for (const item of history) select.add(new Option(`${date(item.createdAt)} · 기록 ${item.id}`, String(item.id)));
  }
  function renderMemories(preserve) {
    if (!preserve) $('memory-list').replaceChildren();
    const cards = new Map([...$('memory-list').children].map((card) => [Number(card.dataset.id), card]));
    const liveIds = new Set(state.memories.map((m) => m.id));
    for (const id of drafts.keys()) if (!liveIds.has(id)) drafts.delete(id);
    for (const [id, card] of cards) if (!liveIds.has(id)) card.remove();
    for (const [index, m] of state.memories.entries()) {
      const existing = cards.get(m.id);
      if (existing && existing.dataset.version === String(m.version) && existing.dataset.session === String(m.session) && existing.dataset.history === JSON.stringify(m.history.map((h) => [h.id, h.createdAt]))) {
        const position = $('memory-list').children[index];
        if (position !== existing) $('memory-list').insertBefore(existing, position || null);
        continue;
      }
      if (existing) existing.remove();
      const card = node('article', 'memory-card'); card.dataset.id = m.id; card.dataset.status = m.status; card.dataset.version = m.version; card.dataset.session = String(m.session);
      // Store only history IDs/times in DOM; original/history text stays in state.
      card.dataset.history = JSON.stringify(m.history.map((h) => [h.id, h.createdAt]));
      const meta = node('div', 'memory-meta'), time = node('time', '', date(m.createdAt)); time.dateTime = m.createdAt;
      meta.append(node('span', 'status-badge', labels[m.status]), node('span', '', m.session === null ? '미분류' : `${m.session}회차`), node('span', '', m.nickname || '익명의 관객'), time);
      card.append(meta, node('p', 'original-label', '참여자 원문 · 수정하지 않음'), node('blockquote', 'memory-original', m.text), node('p', 'current-label', '현재 공개용 문구'), node('p', 'memory-current', m.displayText ?? m.text));
      card.append(node('p','original-label','관리자 전용 · 더 들려주고 싶은 이야기'),node('p','memory-question2',m.question2 || '(빈 응답)'),node('p','memory-read-aloud',`직접 낭독: ${m.readAloud === null ? '미응답(기존 글)' : m.readAloud ? '네' : '아니오'} · 크레딧 동의: ${m.creditConsent ? '네' : '아니오'} · 공개·보관 동의: ${m.publicConsent === null ? '기존 기록 미확인' : m.publicConsent ? '네' : '아니오'}`));
      card.append(node('p','memory-consent-scope',`공개 범위: ${m.publicScope} · 정책: ${m.consentPolicy ?? '기존 동의(버전 미기록)'} · 검수 상태와 별도로 동의 범위가 적용됩니다.`));
      const moderation = node('div', 'actions');
      for (const action of ['pending','visible', 'hidden', 'delete']) {
        const button = node('button', action === 'delete' ? 'danger' : action === 'visible' ? 'primary' : '', action === 'delete' ? '영구 삭제' : labels[action]+'로 변경');
        button.type = 'button'; button.dataset.action = action; button.hidden = m.status === action; moderation.append(button);
      }
      card.append(moderation);
      const edit = node('details', 'memory-editor'); edit.append(node('summary', '', '공개용 문구 수정 · 기록 보기'));
      const label = node('label', '', '공개할 문구 · 2~120자'); label.htmlFor = `memory-draft-${m.id}`;
      const input = node('textarea', 'memory-draft'); input.id = label.htmlFor; input.rows = 3; input.maxLength = 240;
      const d = drafts.get(m.id); input.value = d ? d.text ?? m.text : m.displayText ?? m.text; edit.open = !!d;
      edit.append(label, input, node('p', 'help', '원문은 위에 그대로 남습니다. 수정만으로 숨김·승인 대기 글이 공개되지는 않습니다.'));
      const actions = node('div', 'actions');
      for (const [action, text] of [['preview', '비공개 미리보기'], ['original', '원문을 초안으로']]) { const b = node('button', '', text); b.type = 'button'; b.dataset.action = action; actions.append(b); }
      const p = node('div', 'memory-preview', d?.preview?.rendered ?? ''); p.hidden = !d?.preview;
      const msg = node('p', 'memory-message', d?.preview ? '확인한 내용만 공개 적용할 수 있습니다.' : '미리보기 후 직접 공개 적용해 주세요.'); msg.setAttribute('role', 'status');
      const publish = node('button', 'publish', '이 문구로 공개 적용'); publish.type = 'button'; publish.dataset.action = 'publish';
      const history = node('details', 'history'); history.append(node('summary', '', '이전 문구 가져오기 · 최근 20개'));
      const historyLabel = node('label', '', '이전 공개용 문구'); historyLabel.htmlFor = `memory-history-${m.id}`;
      const select = node('select', 'memory-history'); select.id = historyLabel.htmlFor; histories(select, m.history);
      const restore = node('button', '', '선택한 문구를 초안으로'); restore.type = 'button'; restore.dataset.action = 'restore';
      history.append(historyLabel, select, restore, node('p', 'help', '가져온 뒤 미리보기 → 공개 적용을 눌러야 바뀝니다.'));
      edit.append(actions, p, msg, publish, history); card.append(edit); $('memory-list').insertBefore(card, $('memory-list').children[index] || null);
    }
    filterMemories();
  }
  function filterMemories() {
    let total = 0;
    for (const card of $('memory-list').children) { card.hidden = filter !== 'all' && card.dataset.status !== filter; if (!card.hidden) total++; }
    $('memory-empty').hidden = total > 0;
    document.querySelectorAll('[data-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === filter)));
  }
  function render(next, preserve = false) {
    const keepConfig = preserve && state && next.version === state.version && (dirtyConfig() || preview !== null);
    const oldConfig = keepConfig ? getConfig() : next.config;
    const keepSettings = preserve && state && next.revision === state.revision;
    state = next; appliedApproval = next.approval; locked = false;
    if (!keepConfig) invalidatePreview('현재 공개본입니다. 변경한 뒤 비공개 미리보기를 눌러 주세요.');
    fillConfig(oldConfig);
    if (!keepSettings) { $('paused').checked = state.paused; $('approval').checked = state.approval; }
    for (const [id, d] of drafts) if (state.memories.find((m) => m.id === id)?.version !== d.version) drafts.delete(id);
    $('login-panel').hidden = true; $('dashboard').hidden = false; $('logout').hidden = false;
    put($('published-summary'), state.config.eventName); put($('config-version'), `공개본 v${state.version}`);
    put($('connection'), `확인 ${date(new Date().toISOString())}`); put($('memory-count'), `${state.memories.length}개의 추억`);
    histories($('config-history'), state.history); renderMemories(preserve); controls();
    window.dispatchEvent(new CustomEvent('jungang-presenter',{detail:true}));
  }
  function clearPrivate(text, error = false) {
    window.dispatchEvent(new Event('jungang-session-ended'));
    epoch++; clearTimeout(timer); state = null; locked = false; preview = null; appliedApproval = null; drafts.clear(); filter = 'all';
    $('dashboard').hidden = true; $('logout').hidden = true; $('login-panel').hidden = false;
    $('login-form').reset(); $('config-form').reset(); fields.forEach((key) => { $(key).value = ''; }); $('settings-form').reset();
    $('memory-list').replaceChildren(); $('config-history').replaceChildren(); $('config-preview').hidden = true;
    for (const id of ['published-summary', 'config-version', 'connection', 'memory-count', 'preview-name', 'preview-guide', 'preview-example', 'preview-waiting', 'preview-timing', 'config-message', 'global-message']) put($(id), '');
    $('preview-stage').dataset.scene = 'marquee'; $('preview-stage').dataset.font = 'normal'; message('login-message', text, error); controls();
  }
  function failure(error, write = false) {
    preview = null; for (const d of drafts.values()) d.preview = null;
    if (error.status === 401) { clearPrivate('로그인이 만료됐습니다. 다시 로그인한 뒤 현재 상태를 확인해 주세요.', true); return; }
    if (error.status === 409) {
      locked = true; message('global-message', '다른 담당자가 먼저 변경했습니다. 현재 상태를 새로 불러온 뒤 비교하고 다시 미리보기 해 주세요. 자동 재시도하지 않습니다.', true);
    } else if (error.status === 404) {
      locked = true; message('global-message', '이 추억이나 이전 기록이 삭제되었거나 더 이상 사용할 수 없습니다. 현재 상태를 새로 불러와 확인해 주세요.', true);
    } else if (write && (!error.status || error.status >= 500)) {
      locked = true; message('global-message', '적용 결과를 확인하지 못했습니다. 중복 적용을 막기 위해 버튼을 잠갔습니다. 현재 상태를 새로 불러와 적용 여부부터 확인해 주세요.', true);
    } else {
      message('global-message', [400, 413, 422].includes(error.status) ? '입력 내용을 확인해 주세요. 글자 수·개인정보·꺾쇠 기호·전환 간격을 확인한 뒤 다시 미리보기 하세요.' : error.status === 403 ? '이 주소에서는 변경할 수 없습니다. 안내받은 공식 운영 주소로 접속해 주세요.' : error.status === 429 ? '요청이 많습니다. 잠시 기다렸다 직접 다시 시도해 주세요.' : '서버에 연결하지 못했습니다. 연결을 확인하고 다시 시도해 주세요.', true);
    }
    if (locked) put($('connection'), '현재 상태 재확인 필요');
    $('config-preview').hidden = true;
    document.querySelectorAll('.memory-preview').forEach((p) => { p.hidden = true; });
  }
  async function action(path, payload, { write = false, check, done } = {}) {
    if (busy || locked || !state) return;
    busy = true; epoch++; clearTimeout(timer); controls();
    try {
      const result = await request(path, { eventId: 'jungang-memory', ...payload });
      if (write) {
        const next = await readState();
        if (!check(next, result)) throw new Error('readback mismatch');
        if (path === 'memory' || path === 'moderate') drafts.delete(payload.id);
        if (path === 'publish') preview = null;
        render(next, true); message('global-message', '변경 후 서버의 현재 상태까지 확인했습니다. 공개 화면은 자동으로 갱신됩니다.');
      }
      if (done) done(result);
    } catch (error) { failure(error, write); }
    finally { busy = false; controls(); schedule(); }
  }
  function schedule() { clearTimeout(timer); if (state) timer = setTimeout(poll, 5000); }
  function discardInvalidPrivateCopies() {
    if (!state) return;
    const retained = (item) => Number.isFinite(Date.parse(item.createdAt));
    const oldMemories = state.memories.length, oldHistory = state.history.length;
    state.memories = state.memories.filter(retained);
    state.history = state.history.filter(retained);
    let historiesExpired = false;
    for (const memory of state.memories) {
      const before = memory.history.length;
      memory.history = memory.history.filter(retained);
      historiesExpired ||= before !== memory.history.length;
    }
    // No story/history age TTL. Session expiry and deletion readback below still
    // clear private copies; malformed timestamps are rejected here.
    if (oldMemories !== state.memories.length || historiesExpired) renderMemories(true);
    if (oldHistory !== state.history.length) histories($('config-history'), state.history);
    if (oldMemories !== state.memories.length) put($('memory-count'), `${state.memories.length}개의 추억`);
    controls();
  }
  async function poll() {
    if (!state || busy) return;
    discardInvalidPrivateCopies();
    const generation = epoch;
    try {
      const next = await readState();
      if (generation !== epoch || busy || !state) return;
      // Deletion is not an editable conflict: purge private copies even while
      // unrelated drafts or an uncertain write keep the rest of this tab locked.
      const liveIds = new Set(next.memories.map((m) => m.id));
      state.memories = state.memories.filter((m) => liveIds.has(m.id));
      for (const id of drafts.keys()) if (!liveIds.has(id)) drafts.delete(id);
      for (const card of [...$('memory-list').children]) if (!liveIds.has(Number(card.dataset.id))) card.remove();
      put($('memory-count'), `${state.memories.length}개의 추억`); filterMemories();
      appliedApproval = next.approval;
      // Locked writes require an explicit refresh, but session expiry still clears
      // private DOM. Background reads never silently resolve an uncertain write.
      if (locked) return;
      if (stamp(next) !== stamp(state)) {
        const configConflict = (dirtyConfig() || preview) && next.version !== state.version;
        const settingsConflict = ($('paused').checked !== state.paused || $('approval').checked !== state.approval) && next.revision !== state.revision;
        const memoryConflict = [...drafts].some(([id, d]) => next.memories.find((m) => m.id === id)?.version !== d.version);
        if (configConflict || settingsConflict || memoryConflict) { locked = true; preview = null; message('global-message', '작성 중인 항목이 다른 곳에서 변경되었거나 삭제되었습니다. 초안을 확인한 뒤 현재 상태를 새로 불러와 주세요. 자동 적용하지 않습니다.', true); put($('connection'), '새 상태 있음 · 확인 필요'); }
        else render(next, true);
      }
    } catch (error) {
      if (generation !== epoch) return;
      if (error.status === 401) clearPrivate('로그인이 만료됐습니다. 다시 로그인해 주세요.', true);
      else put($('connection'), '연결 지연 · 마지막 확인 상태');
    } finally { controls(); schedule(); }
  }
  async function reload(initial = false) {
    if (busy) return;
    if (!initial && dirty() && !confirm('아직 적용하지 않은 초안과 미리보기를 버리고, 현재 공개 상태를 불러올까요?')) return;
    busy = true; epoch++; clearTimeout(timer); controls();
    try { const next = await readState(); drafts.clear(); preview = null; render(next); message('global-message', '서버의 현재 공개 상태를 불러왔습니다. 적용 여부를 확인한 뒤 새로 수정해 주세요.'); }
    catch (error) { if (error.status === 401) clearPrivate('전달받은 행사 전용 계정으로 로그인해 주세요.'); else if (state) { locked = true; failure(error); } else message('login-message', '서버 연결을 확인하지 못했습니다. 공식 주소와 연결을 확인한 뒤 로그인해 주세요.', true); }
    finally { busy = false; controls(); schedule(); }
  }
  $('login-form').addEventListener('submit', async (event) => {
    event.preventDefault(); if (busy || state) return;
    const username = $('username').value, password = $('password').value; $('password').value = '';
    busy = true; epoch++; controls(); message('login-message', '계정을 확인하고 있습니다.');
    try {
      const result = await request('login', { username, password }); if (result.ok !== true) throw new Error('login failed');
      render(await readState()); $('username').value = ''; message('global-message', '수정 → 비공개 미리보기 → 공개 적용 순서로 진행하세요. 미리보기는 공개되지 않습니다.'); $('dashboard-title').focus();
    } catch (error) { clearPrivate(error.status === 429 ? '로그인 시도가 많습니다. 잠시 기다렸다 다시 시도해 주세요.' : [401, 403].includes(error.status) ? '아이디·비밀번호 또는 계정 사용 기간을 확인해 주세요.' : '로그인을 확인하지 못했습니다. 연결과 쿠키 허용 여부를 확인해 주세요.', true); }
    finally { busy = false; controls(); schedule(); }
  });
  $('logout').addEventListener('click', async () => {
    if (busy) return; busy = true; clearPrivate('로그아웃하고 세션 종료를 확인하고 있습니다.');
    try {
      await request('logout', {});
      try { await request('state'); throw new Error('session still valid'); }
      catch (error) { if (error.status !== 401) throw error; }
      message('login-message', '로그아웃했습니다. 서버 세션 종료를 확인했습니다.');
    } catch { message('login-message', '화면의 비공개 내용은 지웠지만 서버 세션 종료를 확인하지 못했습니다. 연결을 복구한 뒤 로그인하여 다시 로그아웃해 주세요. 공용 기기라면 사이트 쿠키도 삭제해 주세요.', true); }
    finally { busy = false; controls(); $('username').focus(); }
  });
  $('config-form').addEventListener('input', () => invalidatePreview());
  $('config-form').addEventListener('change', () => invalidatePreview());
  $('config-form').addEventListener('submit', (event) => {
    event.preventDefault(); if (!state) return;
    action('preview', { version: state.version, config: getConfig() }, { done: (result) => {
      if (result.version !== state.version || !validConfig(result.config)) throw new Error('invalid preview');
      fillConfig(result.config); preview = { version: result.version, config: configCopy(result.config) };
      put($('preview-name'), preview.config.eventName); put($('preview-guide'), preview.config.participationGuide); put($('preview-example'), preview.config.inputExample); put($('preview-waiting'), preview.config.waitingText);
      $('preview-stage').dataset.scene = preview.config.background === 'auto' ? 'marquee' : preview.config.background; $('preview-stage').dataset.font = preview.config.fontSize;
      put($('preview-timing'), `무작위 사연만 ${preview.config.intervalSeconds}초마다 전환 · 직접 낭독은 수동 진행 · 단순 가독 배경`);
      $('config-preview').hidden = false; message('config-message', '확인 완료 · 아직 공개되지 않았습니다. 아래 버튼을 눌러야 반영됩니다.');
    } });
  });
  $('publish-config').addEventListener('click', () => {
    if (!preview || !same(getConfig(), preview.config)) return;
    const confirmed = preview;
    action('publish', { version: confirmed.version, config: confirmed.config }, { write: true, check: (s, r) => Number.isInteger(r.version) && s.version === r.version && s.version > confirmed.version && same(configCopy(s.config), confirmed.config) });
  });
  $('discard-config').addEventListener('click', () => { if (!state) return; fillConfig(state.config); invalidatePreview('현재 공개본을 초안으로 불러왔습니다. 공개 상태는 바뀌지 않았습니다.'); });
  $('config-history').addEventListener('change', controls);
  $('restore-config').addEventListener('click', () => {
    const history = state?.history.find((h) => String(h.id) === $('config-history').value); if (!history) return;
    action('restore', { version: state.version, historyId: history.id }, { done: (r) => { if (r.version !== state.version || !validConfig(r.config)) throw new Error('invalid restore'); fillConfig(r.config); invalidatePreview('이전 설정을 초안으로 가져왔습니다. 아직 공개되지 않았습니다. 미리보기 후 공개 적용해 주세요.'); } });
  });
  $('settings-form').addEventListener('change', controls);
  $('settings-form').addEventListener('submit', (event) => {
    event.preventDefault(); if (!state) return;
    const payload = { revision: state.revision, paused: $('paused').checked, approval: $('approval').checked };
    action('settings', payload, { write: true, check: (s) => s.revision > payload.revision && s.paused === payload.paused && s.approval === payload.approval });
  });
  function memoryDraft(card, m) {
    let d = drafts.get(m.id);
    if (!d) { d = { version: m.version, text: card.querySelector('.memory-draft').value, preview: null }; drafts.set(m.id, d); }
    return d;
  }
  $('memory-list').addEventListener('input', (event) => {
    if (!event.target.matches('.memory-draft') || busy || locked) return;
    const card = event.target.closest('.memory-card'), m = state.memories.find((m) => String(m.id) === card.dataset.id), d = memoryDraft(card, m);
    d.text = event.target.value; d.preview = null; card.querySelector('.memory-preview').hidden = true; put(card.querySelector('.memory-message'), '내용이 바뀌었습니다. 다시 미리보기 해 주세요.'); controls();
  });
  $('memory-list').addEventListener('change', controls);
  $('memory-list').addEventListener('click', (event) => {
    const b = event.target.closest('button[data-action]'); if (!b || busy || locked || !state) return;
    const card = b.closest('.memory-card'), m = state.memories.find((m) => String(m.id) === card.dataset.id); if (!m) return;
    const which = b.dataset.action;
    if (which === 'delete') {
      if (!confirm('이 추억을 영구 삭제할까요?\n원문·별명·공개용 문구·수정 이력이 모두 삭제되며 복구할 수 없습니다.\n숨기기는 다시 공개할 수 있지만, 영구 삭제는 되돌릴 수 없습니다.')) return;
      action('moderate', { id: m.id, version: m.version, status: 'delete', confirmDelete: true }, { write: true, check: (s, r) => r.ok === true && r.deletedId === m.id && !s.memories.some((item) => item.id === m.id) }); return;
    }
    if (['pending','visible','hidden'].includes(which)) { action('moderate', { id: m.id, version: m.version, status: which }, { write: true, check: (s) => { const now = s.memories.find((item) => item.id === m.id); return now?.status === which && now.version > m.version; } }); return; }
    const d = memoryDraft(card, m);
    const draftLoaded = (text) => { d.text = text; d.preview = null; card.querySelector('.memory-draft').value = text ?? m.text; card.querySelector('.memory-preview').hidden = true; put(card.querySelector('.memory-message'), '초안으로 가져왔습니다. 아직 적용되지 않았습니다. 미리보기 후 공개 적용해 주세요.'); controls(); };
    if (which === 'original') draftLoaded(null);
    else if (which === 'restore') {
      const h = m.history.find((h) => String(h.id) === card.querySelector('.memory-history').value); if (!h) return;
      action('restore-memory', { id: m.id, version: d.version, historyId: h.id }, { done: (r) => { if (r.id !== m.id || r.version !== d.version || !(r.text === null || typeof r.text === 'string')) throw new Error('invalid restore'); draftLoaded(r.text); } });
    } else if (which === 'preview') {
      action('preview-memory', { id: m.id, version: d.version, text: d.text }, { done: (r) => {
        if (r.id !== m.id || r.version !== d.version || typeof r.text !== 'string') throw new Error('invalid preview');
        if (d.text !== null) d.text = r.text;
        card.querySelector('.memory-draft').value = r.text; d.preview = { text: d.text, rendered: r.text };
        put(card.querySelector('.memory-preview'), r.text); card.querySelector('.memory-preview').hidden = false; put(card.querySelector('.memory-message'), '확인 완료 · 아래 버튼을 눌러야 공개용 문구가 바뀝니다.');
      } });
    } else if (which === 'publish' && d.preview && same(d.text, d.preview.text)) {
      const payload = { id: m.id, version: d.version, text: d.text };
      action('memory', payload, { write: true, check: (s) => { const now = s.memories.find((item) => item.id === m.id); return now && now.displayText === payload.text && now.version > payload.version && now.text === m.text && now.nickname === m.nickname && now.createdAt === m.createdAt; } });
    }
  });
  document.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => { filter = b.dataset.filter; filterMemories(); }));
  $('refresh').addEventListener('click', () => reload());
  window.addEventListener('pagehide', () => { epoch++; clearTimeout(timer); });
  setInterval(discardInvalidPrivateCopies, 30000);
  window.addEventListener('pageshow', (event) => { if (event.persisted) { clearPrivate('세션을 다시 확인하고 있습니다.'); reload(true); } });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state && !busy) poll(); });
  reload(true);
})();
