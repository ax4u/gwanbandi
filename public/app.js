(() => {
  'use strict';
  const base = '/jungang-memory/';
  const isScreen = document.body.dataset.page === 'screen';
  const $ = (id) => document.getElementById(id);
  const put = (node, value) => { if (node && node.textContent !== String(value)) node.textContent = String(value); };
  const count = (value) => Array.from(value).length;
  const normalize = (value) => value.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  const scenes = new Set(['marquee', 'screen', 'street', 'blossom']);
  const consentPolicy = 'jungang-story-unlimited-v1';
  const config = { pollMs: 1500, maxText: 120, maxNickname: 16, retentionDays: null };
  const defaultDisplay = { eventName: '관객-반응-디피 시스템 (관반디)', participationGuide: '사소한 기억도 좋아요. 당신의 말로 남겨 주세요.', inputExample: '이곳에 당신의 기억을 적어 주세요.', waitingText: '기억이 모이면, 다시 이야기가 시작됩니다.', background: 'auto', fontSize: 'normal', intervalSeconds: 3 };
  let display = { ...defaultDisplay };
  let displaySignature = '';
  let rotationKey = '', owned = false, stateAt = 0, capabilityTheater = null;
  // Keep the authored default typography/line breaks; custom values are text only.
  const authoredNames = [...document.querySelectorAll('[data-event-name]')].map((el) => ({ el, children: [...el.childNodes].map((n) => n.cloneNode(true)) }));
  const authoredIntro = $('event-intro') ? [...$('event-intro').childNodes].map((n) => n.cloneNode(true)) : [];
  const storageKey = 'jungang-memory:unconfirmed:v2';
  let configReady = false;
  let connected = false;
  let state = null;
  let pollTimer;
  let polling = false;
  let currentId = null;
  let localPaused = false;
  let publicSignature = '';
  let pending = null;
  let sending = false;
  let receipt = null;
  let retryAt = 0;
  let retryTimer;
  let storageAvailable = true;

  async function request(path, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(base + 'api/' + path, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const error = new Error('request failed');
        error.status = response.status;
        const retry = response.headers.get('Retry-After');
        error.retryMs = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now()) || 0;
        throw error;
      }
      if (!data || typeof data !== 'object') throw new Error('invalid response');
      return data;
    } finally { clearTimeout(timeout); }
  }

  function connection(ok, message) {
    connected = ok;
    if (isScreen && !ok) {
      window.dispatchEvent(new Event('jungang-disconnected'));
      put($('screen-text'), '');
      put($('screen-nickname'), '');
    }
    if (!isScreen && !ok) {
      // Offline copies cannot confirm legacy expiry, withdrawal or deletion.
      $('memory-list').replaceChildren(); publicSignature = '';
      put($('memory-total'), '—'); $('memories-empty').hidden = false;
      put($('empty-title'), '연결을 확인하고 있습니다.');
      put($('empty-description'), '공개 조건을 다시 확인한 뒤 추억을 보여 드립니다.');
    }
    $('connection-status').dataset.connected = String(ok);
    put($('connection-status'), message);
    $('reconnect').hidden = ok;
    if (isScreen && !ok) put($('screen-mode'), '연결 지연 · 마지막 수신 화면');
  }

  async function loadConfig() {
    const data = await request('config');
    const publicUrl = new URL(data.publicUrl);
    if (!['https:', 'http:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password) throw new Error('invalid public URL');
    for (const key of ['maxText', 'maxNickname', 'pollMs']) {
      if (!Number.isInteger(data[key]) || data[key] <= 0) throw new Error('invalid configuration');
    }
    if (data.retentionDays !== null || data.consentPolicy !== consentPolicy || (!isScreen && $('memory-consent').dataset.consentPolicy !== consentPolicy)) throw new Error('consent policy mismatch; reload page');
    Object.assign(config, data, { pollMs: Math.max(1500, data.pollMs) });
    configReady = true;

    document.querySelectorAll('[data-max-text]').forEach((node) => put(node, config.maxText));
    if (isScreen) {
      $('join-link').href = publicUrl.href;
      $('join-url').href = publicUrl.href;
      put($('join-url'), publicUrl.host + publicUrl.pathname + publicUrl.search + publicUrl.hash);
    } else {
      counters();
      updateSubmit();
      if (!pending && !receipt && !sending) formMessage('준비됐어요. 당신의 기억을 들려주세요.');
    }
  }

  function validState(data) {
    if (!Array.isArray(data.memories) || typeof data.paused !== 'boolean' || typeof data.approval !== 'boolean' || !Number.isInteger(data.total) || data.total < 0) throw new Error('invalid state');
    if (data.memories.some((item) => !item || !['string', 'number'].includes(typeof item.id) || typeof item.text !== 'string' || typeof item.nickname !== 'string')) throw new Error('invalid memory');
    return { ...data, memories: [...data.memories].sort((a, b) => (new Date(b.createdAt).getTime() || 0) - (new Date(a.createdAt).getTime() || 0)) };
  }

  function applyDisplay() {
    const candidate = state.config || {};
    const next = { ...defaultDisplay };
    for (const key of ['eventName', 'participationGuide', 'inputExample', 'waitingText']) {
      if (typeof candidate[key] === 'string' && candidate[key].trim()) next[key] = candidate[key];
    }
    if (candidate.background === 'auto' || scenes.has(candidate.background)) next.background = candidate.background;
    if (['small', 'normal', 'large'].includes(candidate.fontSize)) next.fontSize = candidate.fontSize;
    if (Number.isInteger(candidate.intervalSeconds) && candidate.intervalSeconds >= 1 && candidate.intervalSeconds <= 60) next.intervalSeconds = candidate.intervalSeconds;
    display = next;
    const signature = JSON.stringify(display);
    if (signature !== displaySignature) {
      displaySignature = signature;
      for (const { el, children } of authoredNames) {
        if (display.eventName === defaultDisplay.eventName) el.replaceChildren(...children.map((n) => n.cloneNode(true)));
        else put(el, display.eventName);
        const link = el.closest('a.brand');
        if (link) link.setAttribute('aria-label', display.eventName + ' 처음으로');
      }
      document.title = (isScreen ? '상영 화면 | ' : '') + display.eventName;
      document.body.classList.toggle('custom-event', display.eventName !== defaultDisplay.eventName);
      if (isScreen) $('projector').dataset.font = display.fontSize;
      else {
        put($('participation-guide'), display.participationGuide);
        if (display.participationGuide === defaultDisplay.participationGuide) $('event-intro').replaceChildren(...authoredIntro.map((n) => n.cloneNode(true)));
        else put($('event-intro'), display.participationGuide);
        $('memory-text').placeholder = display.inputExample;
      }
    }
    const key=isScreen ? JSON.stringify([state.theater.session,state.theater.operation.runId,owned]) : '';
    if (isScreen && rotationKey !== key) {
      rotationKey=key;currentId=null;
    }
  }



  async function poll() {
    if (polling) return;
    clearTimeout(pollTimer);
    polling = true;
    try {
      if (!configReady) {
        try { await loadConfig(); }
        catch {
          if (!isScreen && !pending) formMessage('참여 설정을 불러오지 못했어요. 자동으로 다시 연결합니다.', true);
        }
      }
      const nextState = validState(await request('state'));
      if(isScreen&&capabilityTheater?.revision>nextState.theater.revision){
        if(capabilityTheater.session!==nextState.theater.session){nextState.memories=[];nextState.credits=[];}
        nextState.theater=capabilityTheater;
      }
      if(!isScreen && state?.intakeSession && state.intakeSession!==nextState.intakeSession && !pending)$('memory-consent').checked=false;
      state = nextState;
      stateAt=performance.now();
      if(!isScreen)put($('intake-session'),'현재 접수: '+(pending?.session??state.intakeSession)+'회차 · 이 회차로 사연이 저장됩니다.');
      applyDisplay();
      connection(true, configReady ? '연결됨 · 자동 새로고침' : '추억 연결됨 · 참여 설정 재확인 중');
      put($('memory-total'), isScreen ? `공개된 추억 ${state.total}개` : state.total);
      if (!isScreen) $('memory-total').setAttribute('aria-label', `공개된 추억 ${state.total}개`);
      if (isScreen) { renderScreen(); window.dispatchEvent(new CustomEvent('jungang-state', { detail: state })); } else renderPublic();
    } catch {
      connection(false, navigator.onLine === false ? '오프라인 · 연결을 기다리는 중' : '연결 지연 · 자동 재연결 중');
      if (!state) {
        if (isScreen) put($('screen-nickname'), '');
        else { put($('empty-title'), '아직 추억을 불러오지 못했어요.'); put($('empty-description'), '연결을 확인한 뒤 다시 시도해 주세요. 기존 추억은 삭제되지 않습니다.'); }
      }
    } finally {
      polling = false;
      pollTimer = setTimeout(poll, document.hidden ? Math.max(config.pollMs, 5000) : config.pollMs);
    }
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function renderPublic() {
    $('public-pause-notice').hidden = !state.paused;
    put($('approval-description'), '공개·상영에 동의한 새 추억은 접수 후 공개 가능하며, 운영자가 나중에 숨길 수 있어요.');
    const latest = state.memories.slice(0, 6);
    const signature = JSON.stringify(latest);
    if (signature !== publicSignature) {
      publicSignature = signature;
      const fragment = document.createDocumentFragment();
      for (const memory of latest) {
        const card = element('article', 'memory-card');
        const quote = element('span', 'card-quote', '“');
        quote.setAttribute('aria-hidden', 'true');
        const text = element('blockquote', '', memory.text);
        const meta = element('div', 'memory-meta');
        meta.append(element('span', 'memory-author', memory.nickname || '익명의 관객'));
        const date = new Date(memory.createdAt);
        if (!Number.isNaN(date.getTime())) {
          const time = element('time', '', new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric' }).format(date));
          time.dateTime = date.toISOString();
          meta.append(time);
        }
        card.append(quote, text, meta);
        fragment.append(card);
      }
      $('memory-list').replaceChildren(fragment);
    }
    $('memories-empty').hidden = latest.length > 0;
    if (!latest.length) { put($('empty-title'), '첫 번째 추억을 기다리고 있어요.'); put($('empty-description'), '당신의 한 줄로 오늘의 상영회를 열어 주세요.'); }
    if (receipt?.status === 'pending' && state.memories.some((item) => String(item.id) === String(receipt.id))) {
      receipt.status = 'visible';
      showReceipt(false);
    }
  }

  function renderScreen() {
    const show=connected&&owned&&state&&performance.now()-stateAt<6000&&state.theater.operation.running&&state.theater.mode==='story';
    $('story-stage').hidden=!show;
    if(!show){put($('screen-text'),'');put($('screen-nickname'),'');return;}
    const latest = state.memories;
    const mode = state.theater.operation.storyMode;
    const five = mode === 'reading-five', all = mode === 'reading-all', direct = five || all;
    $('story-stage').dataset.storyMode = mode;
    // The server supplies only eligible current-session IDs in the operator's reading order.
    const readingIds = five && Array.isArray(state.theater.readingFiveIds) ? state.theater.readingFiveIds.slice(0, 5) : all && Array.isArray(state.theater.readingAllIds) ? state.theater.readingAllIds : [];
    let memory = state.memories.find((item) => String(item.id) === currentId);
    if(state.theater.operation.storyMode!=='random')memory=state.memories.find(item=>String(item.id)===String(state.theater.storyId));
    else if(!localPaused&&!state.paused){memory=state.memories.find(item=>String(item.id)===String(state.theater.storyId));}
    if(direct && !readingIds.some(id=>String(id)===String(memory?.id)))memory=null;
    currentId = memory ? String(memory.id) : null;
    $('screen-eyebrow').hidden = !direct || !memory;
    $('screen-story-title').hidden = !direct || !memory || typeof memory.title !== 'string' || !memory.title.trim();
    put($('screen-story-title'), $('screen-story-title').hidden ? '' : memory.title);
    if (memory) {
      put($('screen-text'), memory.text);
      $('screen-text').dataset.length = count(memory.text) > 75 ? 'long' : count(memory.text) > 38 ? 'medium' : 'short';
      put($('screen-nickname'), memory.nickname || (direct ? '어느 관객의 기억' : '익명의 관객'));
      $('scene-backdrop').dataset.scene = scenes.has(memory.scene) ? memory.scene : 'marquee';
      const index = latest.findIndex((item) => String(item.id) === currentId);
      put($('screen-position'), index < 0 ? '잠시 머무르는 추억' : `최근 추억 ${index + 1} / ${latest.length}`);
      put($('screen-eyebrow'), direct ? `관객이 보내 온 장면  ${readingIds.findIndex(id=>String(id)===currentId)+1} / ${readingIds.length}` : '당신의 한 줄이, 오늘의 한 장면으로');
    } else {
      put($('screen-text'), display.waitingText === defaultDisplay.waitingText ? '기억이 모이면,\n다시 이야기가 시작됩니다.' : display.waitingText);
      $('screen-text').dataset.length = count(display.waitingText) > 75 ? 'long' : count(display.waitingText) > 38 ? 'medium' : 'short';
      put($('screen-nickname'), '함께 나눌 추억을 기다리고 있습니다.');
      put($('screen-position'), '아직 공개된 추억이 없습니다.');
      put($('screen-eyebrow'), '우리의 기억으로 채우는 스크린');
      $('scene-backdrop').dataset.scene = 'marquee';
    }
    if (display.background !== 'auto') $('scene-backdrop').dataset.scene = display.background;
    put($('screen-mode'), !connected ? '연결 지연 · 마지막 수신 화면' : state.paused ? '운영자 일시정지' : localPaused ? '이 화면 전환 멈춤' : '추억 상영 중');
    put($('screen-message'), state.paused ? '운영자가 상영을 잠시 멈췄습니다. 추억 남기기는 계속할 수 있어요.' : localPaused ? '이 화면의 자동 전환을 멈췄습니다. 숨겨진 글은 계속 제외됩니다.' : '');
  }

  function formMessage(message, error = false) {
    put($('form-message'), message);
    $('form-message').classList.toggle('error', error);
  }

  function counters() {
    const textLength = count(normalize($('memory-text').value));
    const nicknameLength = count(normalize($('memory-nickname').value));
    put($('question2-count'), `${count(normalize($('memory-question2').value))} / 500`);
    put($('text-count'), `${textLength} / ${config.maxText}`);
    put($('nickname-count'), `${nicknameLength} / ${config.maxNickname}`);
    $('text-count').classList.toggle('over-limit', textLength > config.maxText);
    $('nickname-count').classList.toggle('over-limit', nicknameLength > config.maxNickname);
  }

  function updateSubmit() {
    const locked = !!pending || sending;
    $('memory-text').disabled = locked;
    $('memory-nickname').disabled = locked;
    $('memory-consent').disabled = locked;
    $('credit-consent').disabled = locked;
    for (const id of ['memory-question2','read-aloud-yes','read-aloud-no']) $(id).disabled = locked;
    const cooling = Date.now() < retryAt;
    $('submit-memory').disabled = sending || cooling || !configReady;
    put($('submit-memory'), sending ? '추억을 보내고 있어요…' : cooling ? '잠시 후 다시 시도해 주세요' : pending ? '같은 요청으로 전송 결과 확인' : '스크린에 추억 보내기 ↗');
    $('discard-request').hidden = !pending || sending;
  }

  function rememberPending(value) {
    pending = value;
    try {
      if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
      else sessionStorage.removeItem(storageKey);
    } catch { storageAvailable = false; }
  }

  function uuid() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map((n) => n.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function validate(text, nickname, question2) {
    if (count(text) < 2 || count(text) > config.maxText) return ['memory-text', `추억은 2~${config.maxText}자로 적어 주세요.`];
    if (count(nickname) > config.maxNickname) return ['memory-nickname', `별명은 ${config.maxNickname}자 이내로 적어 주세요.`];
    if (count(question2) > 500) return ['memory-question2','두 번째 이야기는 500자 이내로 적어 주세요.'];
    if (!$('read-aloud-yes').checked && !$('read-aloud-no').checked) return ['read-aloud-yes','사연을 직접 낭독할지 네 또는 아니오를 선택해 주세요.'];
    for (const [id, value] of [['memory-text', text], ['memory-nickname', nickname], ['memory-question2',question2]]) {
      if (/[<>\u0000-\u0008\u000b-\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)) return [id, '꺾쇠 기호와 제어 문자는 사용할 수 없어요.'];
      if (/[\w.+-]+@[\w.-]+\.[a-z]{2,}/iu.test(value) || /(?:\+?82[\s.-]?)?0?1[016789][\s.-]?\d{3,4}[\s.-]?\d{4}/u.test(value)) return [id, '전화번호나 이메일은 공개할 수 없어요. 개인정보를 지워 주세요.'];
    }
    if (!$('memory-consent').checked) return ['memory-consent', '글·별명의 공개와 보관 안내에 동의해 주세요.'];
    return null;
  }

  function showReceipt(focus = true) {
    $('memory-form').hidden = true;
    $('submission-receipt').hidden = false;
    put($('receipt-title'), (receipt.session?receipt.session+'회차 · ':'기존 미분류 접수 · ')+(receipt.status === 'pending' ? '추억이 도착했어요.' : '소중한 추억을 남겼어요.'));
    const scope = receipt.consentPolicy === consentPolicy ? ' 새 동의 글은 공개·상영 기간 제한이 없으며, 응답은 삭제 요청 또는 관리자 삭제 전까지 보관됩니다.' : ' 기존 접수를 확인했습니다. 당시 동의한 작성 후 7일 공개 조건을 유지하며, 기간이 지난 글은 공개되지 않습니다.';
    put($('receipt-description'), (receipt.status === 'pending' ? '추억을 접수했습니다. 운영자의 검수·공개 조건에 따라 소개됩니다.' : '추억 접수를 확인했습니다. 공개 가능한 글을 순서대로 소개합니다.') + scope + ' 동의 철회·공개 중단·삭제 요청: ' + config.deletionContact);
    if (focus) $('submission-receipt').focus();
  }

  async function submit(event) {
    event.preventDefault();
    if (sending || !configReady || Date.now() < retryAt) return;
    if (!pending) {
      const text = normalize($('memory-text').value);
      const nickname = normalize($('memory-nickname').value);
      const question2 = normalize($('memory-question2').value);
      const invalid = validate(text, nickname, question2);
      ['memory-text', 'memory-nickname', 'memory-consent','memory-question2','read-aloud-yes'].forEach((id) => $(id).removeAttribute('aria-invalid'));
      if (invalid) {
        $(invalid[0]).setAttribute('aria-invalid', 'true');
        formMessage(invalid[1], true);
        $(invalid[0]).focus();
        return;
      }
      try { rememberPending({ text, nickname, question2, session:state?.intakeSession, readAloud:$('read-aloud-yes').checked, publicConsent:true, consentPolicy, creditConsent: $('credit-consent').checked, requestId: uuid() }); }
      catch { formMessage('안전한 요청 번호를 만들 수 없어요. 최신 브라우저에서 다시 열어 주세요.', true); return; }
    }
    sending = true;
    updateSubmit();
    formMessage('추억을 보내고 있어요. 창을 닫지 말아 주세요.');
    try {
      const result = await request('memories', pending);
      if (!['string', 'number'].includes(typeof result.id) || !['visible', 'pending'].includes(result.status)) throw new Error('invalid receipt');
      receipt = { id: result.id, session:result.session, status: result.status, consentPolicy:result.consentPolicy };
      rememberPending(null);
      $('memory-form').reset();
      counters();
      showReceipt();
      poll();
    } catch (error) {
      if (error.status === 428 || error.status === 410) {
        rememberPending(null);
        $('memory-consent').checked = false;
        formMessage(error.status === 410 ? '삭제된 요청은 다시 접수하지 않습니다. 삭제 문의: ' + config.deletionContact : '이전 안내로는 새 글을 접수할 수 없어요. 변경된 공개·보관 안내를 읽고 직접 다시 동의해 주세요.', true);
      } else if ([400, 413, 422].includes(error.status)) {
        rememberPending(null);
        formMessage('글을 접수하지 못했어요. 길이, 개인정보, 특수 문자를 확인하고 수정해 주세요.', true);
      } else if (error.status === 429) {
        const delay = Math.min(Math.max(error.retryMs || 15000, 1000), 3600000);
        retryAt = Date.now() + delay;
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => { retryAt = 0; updateSubmit(); formMessage('같은 요청으로 다시 확인할 수 있어요. 중복 접수되지 않습니다.'); }, delay);
        formMessage('잠시 많은 요청이 모였어요. 입력은 보관했으니 잠시 후 같은 요청으로 다시 확인해 주세요.', true);
      } else if (error.status === 409) {
        formMessage('이 요청 번호로 다른 내용이 이미 접수됐어요. 요청을 정리하기 전에 기존 접수 여부를 확인해 주세요.', true);
      } else if (error.status === 403) {
        formMessage('이 주소에서는 접수할 수 없어요. 행사에서 안내한 공식 참여 주소로 접속해 주세요. 입력은 유지됩니다.', true);
      } else {
        formMessage(`전송 결과를 확인하지 못했어요. 아래 버튼으로 같은 요청을 다시 확인해 주세요. 중복 접수되지 않습니다.${storageAvailable ? '' : ' 이 브라우저는 임시 저장이 안 되므로 창을 닫지 마세요.'}`, true);
      }
    } finally { sending = false; updateSubmit(); }
  }

  if (isScreen) {
    window.addEventListener('jungang-capability',e=>{
      owned=e.detail.owned;capabilityTheater=e.detail.theater;
      if(state&&capabilityTheater&&capabilityTheater.revision>=state.theater.revision){
        if(capabilityTheater.session!==state.theater.session){state.memories=[];stateAt=0;}
        state.theater=capabilityTheater;applyDisplay();
      }
      renderScreen();
    });
    setInterval(()=>{if(state&&performance.now()-stateAt>=6000)renderScreen();},500);
    $('local-pause').addEventListener('click', () => {
      localPaused = !localPaused;
      $('local-pause').setAttribute('aria-pressed', String(localPaused));
      put($('local-pause'), localPaused ? '자동 전환 재개' : '자동 전환 멈춤');
      if (state) renderScreen();
    });

    $('fullscreen').addEventListener('click', async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else if (document.body.requestFullscreen) await document.body.requestFullscreen();
        else throw new Error('unsupported');
      } catch { put($('screen-message'), '이 브라우저에서는 전체 화면을 열 수 없어요. 브라우저의 전체 화면 기능을 이용해 주세요.'); }
    });
    document.addEventListener('fullscreenchange', () => put($('fullscreen'), document.fullscreenElement ? '전체 화면 종료' : '전체 화면'));
    const qrImage = $('join-link').querySelector('img');
    const qrError = () => put(document.querySelector('.qr-caption'), 'QR을 불러오지 못했어요. 아래 주소로 참여해 주세요.');
    qrImage.addEventListener('error', qrError);
    if (qrImage.complete && !qrImage.naturalWidth) qrError();
  } else {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
      if (saved && typeof saved.text === 'string' && typeof saved.nickname === 'string' && typeof saved.question2 === 'string' && typeof saved.readAloud === 'boolean' && saved.publicConsent === true && /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(saved.requestId)) {
        // Preserve the original consent marker (including absence). Never upgrade
        // an unconfirmed request simply because a new page/script loaded.
        pending = { text: saved.text, nickname: saved.nickname, question2:saved.question2, ...(saved.session===undefined?{}:{session:saved.session}), readAloud:saved.readAloud, publicConsent:true, ...(saved.consentPolicy === undefined ? {} : {consentPolicy:saved.consentPolicy}), creditConsent: saved.creditConsent === true, requestId: saved.requestId };
        $('memory-question2').value=pending.question2;
        $(pending.readAloud ? 'read-aloud-yes' : 'read-aloud-no').checked=true;
        $('memory-text').value = pending.text;
        $('memory-nickname').value = pending.nickname;
        $('memory-consent').checked = pending.consentPolicy === consentPolicy;
        $('credit-consent').checked = pending.creditConsent;
        formMessage('결과가 확인되지 않은 전송이 있어요. 같은 요청으로 다시 확인하면 중복 접수되지 않습니다.');
      } else if (saved) sessionStorage.removeItem(storageKey);
    } catch { storageAvailable = false; }
    $('memory-form').addEventListener('submit', submit);
    ['memory-text', 'memory-nickname','memory-question2'].forEach((id) => $(id).addEventListener('input', () => { $(id).removeAttribute('aria-invalid'); counters(); }));
    $('memory-consent').addEventListener('change', () => $('memory-consent').removeAttribute('aria-invalid'));
    $('discard-request').addEventListener('click', () => {
      if (sending || !confirm('이미 접수된 글이 있을 수 있습니다. 새 요청으로 보내면 중복 글이 생길 수 있어요. 현재 요청 번호를 지우고 내용을 수정할까요?')) return;
      rememberPending(null);
      $('memory-consent').checked = false;
      clearTimeout(retryTimer);
      retryAt = 0;
      updateSubmit();
      formMessage('요청 번호를 정리했어요. 이미 공개된 글이 있는지 확인한 후 보내 주세요.');
      $('memory-text').focus();
    });
    $('write-another').addEventListener('click', () => {
      receipt = null;
      $('submission-receipt').hidden = true;
      $('memory-form').hidden = false;
      formMessage('또 다른 기억이 떠오르셨나요? 다정한 한 줄을 남겨 주세요.');
      updateSubmit();
      $('memory-text').focus();
    });
    counters();
    updateSubmit();
  }
  $('reconnect').addEventListener('click', poll);
  window.addEventListener('online', poll);
  window.addEventListener('offline', () => connection(false, '오프라인 · 연결을 기다리는 중'));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  poll();
})();
