import {randomBytes, scrypt, createHash, timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {EVENT_ID, RETENTION_MS, transaction} from './client-store.mjs';
import {exportMemories} from './event-revision.mjs';

const derive = promisify(scrypt);
const SCRYPT = {N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024};
const USERNAME = /^event-[a-f0-9]{24}$/;
const SHORT_USERNAME = /^[A-Za-z0-9]{1,5}$/;
const SHORT_PASSWORD = /^[\x21-\x7e]{1,5}$/;
export const SHORT_ACCOUNT_POLICY = Object.freeze({
  maxLifetimeMs: 8 * 3600000, recommendedHours: 2,
  failures: 5, windowMs: 15 * 60000, accountAttempts: 5, ipAttempts: 10, globalAttempts: 30,
});
const RATE_PREFIX = 'client-auth:v1:';
// Stable, domain-separated keys survive restarts; these hashes are not a claim
// of IP anonymization. Never store raw identifiers, addresses or credentials.
const rateBucket = (kind, value = '') => RATE_PREFIX + kind + ':' + hash(value);
const failureBucket = username => rateBucket('short-failures', username);
const SESSION_MS = 8 * 3600000;
const COOKIE = '__Secure-jm_event';
const COOKIE_OPTIONS = 'Path=/jungang-memory/manage/; Secure; HttpOnly; SameSite=Strict';
const MAX_SESSIONS = 100;
const MAX_ACCOUNT_SESSIONS = 5;
const hash = value => createHash('sha256').update(value).digest('hex');
const parseHash = value => {
  const parts = typeof value === 'string' ? value.split('$') : [];
  if (parts.length !== 6 || parts.slice(0, 4).join('$') !== 'scrypt$32768$8$1' ||
      !/^[a-f0-9]{32}$/.test(parts[4]) || !/^[a-f0-9]{128}$/.test(parts[5])) return null;
  return {salt: Buffer.from(parts[4], 'hex'), digest: Buffer.from(parts[5], 'hex')};
};

async function passwordHash(password) {
  const salt = randomBytes(16), digest = await derive(password, salt, 64, SCRYPT);
  try { return `scrypt$32768$8$1$${salt.toString('hex')}$${digest.toString('hex')}`; }
  finally { digest.fill(0); }
}
function shortInput(username, password) {
  if (typeof username !== 'string' || !SHORT_USERNAME.test(username) ||
      typeof password !== 'string' || !SHORT_PASSWORD.test(password)) throw Error('Invalid short credentials');
}
function shortExpiry(expiresAt, now = Date.now()) {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + SHORT_ACCOUNT_POLICY.maxLifetimeMs) {
    throw Error('Expiry must be in the next eight hours');
  }
}

// Internal operator/isolated-fixture helpers, never HTTP account-management APIs.
// Short passwords are caller-selected in a non-echoing TTY, never returned.
export async function issueShortClientAccount(db, {username, password, expiresAt} = {}) {
  shortInput(username, password);
  shortExpiry(expiresAt);
  const encoded = await passwordHash(password);
  return transaction(db, () => {
    shortExpiry(expiresAt);
    if (db.prepare('SELECT 1 FROM client_accounts WHERE username=?').get(username)) throw Error('Account already exists');
    if (db.prepare('SELECT COUNT(*) AS n FROM client_accounts WHERE expires_at>?').get(Date.now()).n >= 100) throw Error('Account limit reached');
    db.prepare(`INSERT INTO client_accounts(username,event_id,password_hash,expires_at,created_at)
                VALUES(?,?,?,?,?)`).run(username, EVENT_ID, encoded, expiresAt, Date.now());
    // A newly issued handle may have belonged to an already-expired account.
    // Clear that credential epoch only; IP/global/account rate windows remain.
    db.prepare('DELETE FROM rates WHERE bucket=?').run(failureBucket(username));
    return {username, expiresAt, eventId: EVENT_ID};
  });
}

export async function unlockShortClientAccount(db, {username, password} = {}) {
  shortInput(username, password);
  const before = db.prepare('SELECT * FROM client_accounts WHERE username=?').get(username);
  if (!before || before.event_id !== EVENT_ID || before.enabled !== 0 || before.expires_at <= Date.now()) throw Error('Disabled unexpired short account required');
  const parsed = parseHash(before.password_hash);
  if (!parsed) throw Error('Invalid verifier');
  const check = await derive(password, parsed.salt, 64, SCRYPT);
  let reused;
  try { reused = timingSafeEqual(check, parsed.digest); } finally { check.fill(0); }
  if (reused) throw Error('A different password is required');
  const encoded = await passwordHash(password);
  return transaction(db, () => {
    const changed = db.prepare(`UPDATE client_accounts SET password_hash=?,enabled=1,auth_version=auth_version+1
      WHERE username=? AND event_id=? AND enabled=0 AND auth_version=? AND password_hash=? AND expires_at=? AND expires_at>?`)
      .run(encoded, username, EVENT_ID, before.auth_version, before.password_hash, before.expires_at, Date.now());
    if (changed.changes !== 1) throw Error('Account changed or expired');
    // Explicit operator recovery clears only this account's counters, not the
    // shared IP/global limits. Old in-flight attempts cannot charge a new epoch.
    for (const kind of ['short-failures', 'short-account', 'account']) {
      db.prepare('DELETE FROM rates WHERE bucket=?').run(rateBucket(kind, username));
    }
    return {username, expiresAt: before.expires_at, eventId: EVENT_ID};
  });
}

// Legacy opaque credentials and their existing rotation policy remain supported.
// No HTTP route can call this helper; no automatic credential replacement.
export async function issueClientAccount(db, {expiresAt, rotateUsername} = {}) {
  const now = Date.now();
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + RETENTION_MS) {
    throw Error('Expiry must be in the next seven days');
  }
  if (rotateUsername !== undefined && !USERNAME.test(rotateUsername)) throw Error('Invalid opaque handle');
  const username = rotateUsername ?? `event-${randomBytes(12).toString('hex')}`;
  const password = randomBytes(32).toString('base64url');
  const encoded = await passwordHash(password);
  transaction(db, () => {
    if (expiresAt <= Date.now()) throw Error('Expiry elapsed');
    if (rotateUsername !== undefined) {
      const result = db.prepare(`UPDATE client_accounts SET password_hash=?,enabled=1,expires_at=?,auth_version=auth_version+1
                                 WHERE username=? AND event_id=?`).run(encoded, expiresAt, username, EVENT_ID);
      if (result.changes !== 1) throw Error('Account not found');
    } else {
      db.prepare('DELETE FROM client_accounts WHERE expires_at<=?').run(Date.now());
      if (db.prepare('SELECT COUNT(*) AS n FROM client_accounts').get().n >= 100) throw Error('Account limit reached');
      db.prepare(`INSERT INTO client_accounts(username,event_id,password_hash,expires_at,created_at)
                  VALUES(?,?,?,?,?)`).run(username, EVENT_ID, encoded, expiresAt, now);
    }
  });
  return {username, password, expiresAt, eventId: EVENT_ID};
}

export function revokeClientAccount(db, username) {
  if (typeof username !== 'string' || (!USERNAME.test(username) && !SHORT_USERNAME.test(username))) throw Error('Invalid account handle');
  return transaction(db, () => {
    const result = db.prepare('UPDATE client_accounts SET enabled=0,auth_version=auth_version+1 WHERE username=? AND event_id=?')
      .run(username, EVENT_ID);
    if (result.changes !== 1) throw Error('Account not found');
    return {ok: true};
  });
}

export function createClientAdmin({db, store, operation, origin, readJson, send, fail, now = Date.now}) {
  const prefix = '/jungang-memory/manage/api/';
  const fields = new Map([
    ['login', ['username', 'password']], ['logout', []],
    ['preview', ['version', 'config']], ['publish', ['version', 'config']],
    ['restore', ['version', 'historyId']],
    ['preview-memory', ['id', 'version', 'text']], ['memory', ['id', 'version', 'text']],
    ['restore-memory', ['id', 'version', 'historyId']],
    ['settings', ['revision', 'paused', 'approval']], ['moderate', ['id', 'version', 'status', 'confirmDelete']],
    ['operation', ['revision','command','mode','session','id','version','intervalSeconds','text','uploadId','offset','final','speed','paused','ids','cue']],
    ['playback', ['revision','command','token','clientId','status']],
  ]);
  // Sessions are process-local; all login budgets survive process restarts and
  // are serialized across workers in the existing SQLite rates table.
  const sessions = new Map();
  const dummy = {salt: randomBytes(16), digest: randomBytes(64)};
  let deriving = 0;
  const account = username => db.prepare('SELECT * FROM client_accounts WHERE username=?').get(username);
  const eligible = row => row && row.event_id === EVENT_ID && row.enabled === 1 && row.expires_at > now();
  const limited = () => fail(429, '잠시 후 다시 시도해 주세요.');
  function consumeRates(name, ip, short) {
    const rules = [['global', '', 60, 60000], ['ip', ip, 20, 60000], ['account', name, 8, 60000]];
    if (short) rules.push(
      ['short-global', '', SHORT_ACCOUNT_POLICY.globalAttempts, SHORT_ACCOUNT_POLICY.windowMs],
      ['short-ip', ip, SHORT_ACCOUNT_POLICY.ipAttempts, SHORT_ACCOUNT_POLICY.windowMs],
      ['short-account', name, SHORT_ACCOUNT_POLICY.accountAttempts, SHORT_ACCOUNT_POLICY.windowMs],
    );
    const allowed = transaction(db, () => {
      const time = now();
      // The longest ordinary window is fifteen minutes. Failure reservations use
      // the account expiry as start and remain until expiry, including restarts.
      db.prepare('DELETE FROM rates WHERE bucket LIKE ? AND start<=?').run(RATE_PREFIX + '%', time - SHORT_ACCOUNT_POLICY.windowMs);
      for (const [kind, value, limit, window] of rules) {
        const key = rateBucket(kind, value), old = db.prepare('SELECT start,count FROM rates WHERE bucket=?').get(key);
        if (old && time - old.start < window) {
          if (old.count >= limit) return false;
          db.prepare('UPDATE rates SET count=count+1 WHERE bucket=?').run(key);
        } else {
          if (!old && db.prepare('SELECT COUNT(*) AS n FROM rates WHERE bucket LIKE ?').get(RATE_PREFIX + '%').n >= 2048) return false;
          db.prepare(`INSERT INTO rates(bucket,start,count) VALUES(?,?,1)
            ON CONFLICT(bucket) DO UPDATE SET start=excluded.start,count=1`).run(key, time);
        }
      }
      return true;
    });
    // Throw only after COMMIT: a rejected request must not roll back charges.
    if (!allowed) limited();
  }
  function lock(row) {
    db.prepare('UPDATE client_accounts SET enabled=0,auth_version=auth_version+1 WHERE username=? AND auth_version=? AND enabled=1')
      .run(row.username, row.auth_version);
  }
  function reserveFailure(row) {
    return transaction(db, () => {
      const current = account(row.username);
      if (!eligible(current) || current.auth_version !== row.auth_version || current.password_hash !== row.password_hash || current.expires_at !== row.expires_at) return false;
      const key = failureBucket(row.username), old = db.prepare('SELECT count FROM rates WHERE bucket=?').get(key);
      if (old && old.count >= SHORT_ACCOUNT_POLICY.failures) { lock(current); return false; }
      if (!old && db.prepare('SELECT COUNT(*) AS n FROM rates WHERE bucket LIKE ?').get(RATE_PREFIX + '%').n >= 2048) return false;
      // Reserve before scrypt yields. Crashes conservatively consume a failure;
      // only a verified success in the unchanged epoch refunds its reservation.
      db.prepare(`INSERT INTO rates(bucket,start,count) VALUES(?,?,1)
        ON CONFLICT(bucket) DO UPDATE SET count=count+1`).run(key, row.expires_at);
      return true;
    });
  }
  function pruneSessions() {
    for (const [key, session] of sessions) if (session.expiresAt <= now()) sessions.delete(key);
  }
  function token(req) {
    const matches = (req.headers.cookie || '').split(';').map(value => value.trim())
      .filter(value => value.startsWith(COOKIE + '='));
    if (matches.length !== 1) return null;
    const value = matches[0].slice(COOKIE.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? hash(value) : null;
  }
  function authenticated(req) {
    pruneSessions();
    const key = token(req), session = sessions.get(key);
    const row = session && account(session.username);
    if (!session || !eligible(row) || row.auth_version !== session.authVersion ||
        row.password_hash !== session.passwordHash || row.expires_at !== session.accountExpiry) {
      sessions.delete(key);
      fail(401, '로그인이 필요합니다.');
    }
    return key;
  }
  async function login(req, body) {
    // The listener is loopback-only; the trusted relay must replace this header.
    const name = typeof body.username === 'string' ? body.username : '';
    const short = SHORT_USERNAME.test(name);
    consumeRates(name, String(req.headers['x-jungang-ip'] || req.socket.remoteAddress), short);
    if (deriving >= 4) limited();
    const validInput = (USERNAME.test(name) || short) && typeof body.password === 'string' &&
      body.password.length >= 1 && Buffer.byteLength(body.password) <= 256 && (!short || SHORT_PASSWORD.test(body.password));
    const before = (USERNAME.test(name) || short) ? account(name) : null;
    const parsed = eligible(before) ? parseHash(before.password_hash) : null;
    const reserved = short && parsed ? reserveFailure(before) : false;
    if (short && parsed && !reserved) limited();
    const verifier = parsed || dummy;
    deriving++;
    let matches;
    try {
      const digest = await derive(validInput ? body.password : 'invalid-input', verifier.salt, 64, SCRYPT);
      matches = validInput && timingSafeEqual(digest, verifier.digest);
      digest.fill(0);
    } finally { deriving--; }
    // Serialize the final account/lock recheck with CLI changes and other worker
    // completions. No await occurs between this check and session creation.
    const cookie = transaction(db, () => {
      const current = before && account(name);
      const unchanged = parsed && eligible(current) && current.auth_version === before.auth_version &&
        current.password_hash === before.password_hash && current.expires_at === before.expires_at;
      if (!unchanged) return null;
      if (!matches) {
        if (reserved && db.prepare('SELECT count FROM rates WHERE bucket=?').get(failureBucket(name))?.count >= SHORT_ACCOUNT_POLICY.failures) lock(current);
        return null;
      }
      if (reserved) db.prepare('UPDATE rates SET count=MAX(0,count-1) WHERE bucket=?').run(failureBucket(name));
      pruneSessions();
      const own = [...sessions].filter(([, session]) => session.username === name);
      while (own.length >= MAX_ACCOUNT_SESSIONS) sessions.delete(own.shift()[0]);
      while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
      const raw = randomBytes(32).toString('base64url');
      sessions.set(hash(raw), {
        username: name, authVersion: current.auth_version, passwordHash: current.password_hash,
        accountExpiry: current.expires_at, expiresAt: Math.min(now() + SESSION_MS, current.expires_at),
      });
      return `${COOKIE}=${raw}; ${COOKIE_OPTIONS}; Max-Age=28800`;
    });
    if (!cookie) fail(401, '로그인 정보를 확인해 주세요.');
    return cookie;
  }

  return async function handleClient(req, res) {
    const path = req.url.split('?')[0];
    const action = path.startsWith(prefix) ? path.slice(prefix.length) : '';
    if (req.url !== path) fail(404, 'Not found');
    if (action !== 'export' && action !== 'state' && action !== 'presenter' && !fields.has(action)) fail(404, 'Not found');
    if (req.method === 'GET' && action === 'operation') { authenticated(req); return send(req,res,200,operation.detail()); }
    if (req.method === 'GET' && action === 'export') {
      authenticated(req);
      if (req.url !== prefix + 'export') fail(404, 'Not found');
      return send(req,res,200,exportMemories(db,() => authenticated(req)),'text/csv; charset=utf-8',{
        'Content-Disposition':'attachment; filename="jungang-memory-results.csv"',
        'Cache-Control':'private, no-store', 'Pragma':'no-cache',
      });
    }

    if (req.method === 'GET' && action === 'presenter') {
      authenticated(req);
      return send(req, res, 200, {theater:operation.state()});
    }
    if (req.method === 'GET' && action === 'state') {
      authenticated(req);
      return send(req, res, 200, store.state(() => authenticated(req)));
    }
    if (req.method !== 'POST' || action === 'export' || action === 'state' || action === 'presenter') fail(405, 'Method not allowed');
    if (req.headers.origin !== origin || req.headers['x-jungang-client'] !== '1') {
      fail(403, '공식 행사 주소에서 다시 접속해 주세요.');
    }
    // Reject unauthenticated callers before allocating their request bodies; check
    // again after await to observe account changes and expiry during upload.
    if (action !== 'login') authenticated(req);

    const body = await readJson(req);
    const session = action === 'login' ? null : authenticated(req);
    if (Object.hasOwn(body, 'eventId') && body.eventId !== EVENT_ID) fail(403, '허용되지 않는 행사입니다.');
    if (Object.keys(body).some(key => key !== 'eventId' && !fields.get(action).includes(key))) {
      fail(422, '허용되지 않는 입력입니다.');
    }
    if (action === 'login') {
      const cookie = await login(req, body);
      return send(req, res, 200, {ok: true}, undefined, {'Set-Cookie': cookie});
    }
    if (action === 'logout') {
      sessions.delete(session);
      return send(req, res, 200, {ok: true}, undefined, {'Set-Cookie': `${COOKIE}=; ${COOKIE_OPTIONS}; Max-Age=0`});
    }
    if(action==='operation')return send(req,res,200,operation.execute(body,()=>{const key=authenticated(req);return sessions.get(key).expiresAt;}));
    if(action==='playback')return send(req,res,200,operation.playback(body,session,()=>authenticated(req)));
    return send(req, res, 200, store.execute(action, body, () => authenticated(req)));
  };
}
