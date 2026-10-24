import {readdirSync, unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {LEGACY_PUBLIC_MS, PUBLIC_MEMORY_WHERE, consentScope} from './retention-policy.mjs';
// Additive v2 storage. Originals are never edited; confirmed moderation may delete
// the whole submission and its history. No text-bearing deletion audit is kept.
export const EVENT_ID = 'jungang-memory';
export const RETENTION_MS = 7 * 86400000; // Existing opaque-account maximum; NOT the new story policy.
export const HISTORY_LIMIT = 20;
// Offline migration snapshots carry their earliest source-record expiry in the
// filename. Never refresh the deadline by copying/restarting; no generic cleanup.
export function pruneRollbackBackups(dataDir, now = Date.now()) {
  const dir = resolve(dataDir, 'rollback-backups');
  let files;
  try { files = readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  for (const file of files) {
    const match = /^rollback-until-(\d{13})\.sqlite(?:-wal|-shm)?$/.exec(file);
    if (match && Number(match[1]) <= now) unlinkSync(resolve(dir, file));
  }
}
export const DEFAULT_CONFIG = Object.freeze({
  eventName: '관객-반응-디피 시스템 (관반디)',
  participationGuide: '사소한 기억도 좋아요. 당신의 말로 남겨 주세요.',
  inputExample: '이곳에 당신의 기억을 적어 주세요.',
  waitingText: '기억이 모이면, 다시 이야기가 시작됩니다.',
  background: 'auto', fontSize: 'normal', intervalSeconds: 3,
});

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function migrateClientSchema(db) {
  db.exec('PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if ([2, 3, 4, 5, 6, 7].includes(version)) return;
  if (version !== 1) throw Error('Unsupported database schema');
  transaction(db, () => {
    db.exec(`
      ALTER TABLE memories ADD COLUMN display_text TEXT;
      ALTER TABLE memories ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
      CREATE TABLE client_accounts (
        username TEXT PRIMARY KEY,
        event_id TEXT NOT NULL CHECK(event_id='jungang-memory'),
        password_hash TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK(enabled IN (0,1)) DEFAULT 1,
        expires_at INTEGER NOT NULL,
        auth_version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
      CREATE TRIGGER client_account_changed AFTER UPDATE ON client_accounts
      WHEN NEW.auth_version <= OLD.auth_version BEGIN
        UPDATE client_accounts SET auth_version=OLD.auth_version+1 WHERE username=NEW.username;
      END;
      CREATE TABLE event_config (
        event_id TEXT PRIMARY KEY CHECK(event_id='jungang-memory'),
        version INTEGER NOT NULL DEFAULT 1,
        config TEXT NOT NULL
      );
      CREATE TABLE config_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL REFERENCES event_config(event_id) ON DELETE CASCADE,
        config TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE memory_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        display_text TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX memory_history_parent ON memory_history(memory_id,id);
      CREATE INDEX config_history_created ON config_history(created_at);
      PRAGMA user_version=2;
    `);
    db.prepare('INSERT INTO event_config(event_id,config) VALUES(?,?)')
      .run(EVENT_ID, JSON.stringify(DEFAULT_CONFIG));
  });
}

// Operator-controlled offline code rollback helper. It intentionally removes only
// v2 client data; v1 submissions/settings/frozen state remain intact. Never an API.
export function rollbackClientSchema(db) {
  if (db.prepare('PRAGMA user_version').get().user_version !== 2) throw Error('Expected schema 2');
  transaction(db, () => db.exec(`
    DROP TRIGGER client_account_changed;
    DROP TABLE memory_history;
    DROP TABLE config_history;
    DROP TABLE event_config;
    DROP TABLE client_accounts;
    ALTER TABLE memories DROP COLUMN display_text;
    ALTER TABLE memories DROP COLUMN version;
    PRAGMA user_version=1;
  `));
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

export function createClientStore(db, {validate, fail, onPause = () => {}, onInterval = () => {}}) {
  const stmt = sql => db.prepare(sql);
  const tx = fn => transaction(db, fn);
  // Administrative records persist until an authenticated, confirmed deletion.
  const cutoff = () => -1;
  const settings = () => stmt('SELECT * FROM settings WHERE id=1').get();
  const bump = () => stmt('UPDATE settings SET revision=revision+1 WHERE id=1').run();
  const hasTheater = [3, 4, 5, 6, 7].includes(stmt('PRAGMA user_version').get().user_version);
  const hasRetention = stmt('PRAGMA user_version').get().user_version >= 6;
  const activeSession=()=>stmt('SELECT session FROM theater_state WHERE id=1').get().session;
  function removeFromScreen(id) {
    stmt('DELETE FROM frozen WHERE id=?').run(id);
    if (hasTheater) stmt('UPDATE theater_state SET story_id=NULL,revision=revision+1 WHERE story_id=?').run(id);
  }
  const iso = time => new Date(time).toISOString();
  const positive = value => {
    if (!Number.isSafeInteger(value) || value < 1) fail(422, '올바른 번호가 필요합니다.');
    return value;
  };
  function event() {
    const row = stmt('SELECT version,config FROM event_config WHERE event_id=?').get(EVENT_ID);
    return {version: row.version, config: JSON.parse(row.config)};
  }
  function eventVersion(version) {
    positive(version);
    const current = event();
    if (current.version !== version) fail(409, '다른 변경이 있습니다. 다시 불러와 확인해 주세요.');
    return current;
  }
  function memory(id, version) {
    positive(id); positive(version);
    const row = stmt('SELECT * FROM memories WHERE id=? AND created_at>?').get(id, cutoff());
    if (!row) fail(404, '추억을 찾을 수 없습니다.');
    if (row.version !== version) fail(409, '다른 변경이 있습니다. 다시 불러와 확인해 주세요.');
    return row;
  }
  function config(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(422, '행사 설정이 필요합니다.');
    const lengths = {eventName: 60, participationGuide: 240, inputExample: 120, waitingText: 120};
    const keys = [...Object.keys(lengths), 'background', 'fontSize', 'intervalSeconds'];
    if (Object.keys(value).some(key => !keys.includes(key))) fail(422, '허용되지 않는 설정입니다.');
    const result = {};
    for (const [key, max] of Object.entries(lengths)) result[key] = validate(value[key], max, 1);
    if (!['auto', 'marquee', 'screen', 'street', 'blossom'].includes(value.background) ||
        !['small', 'normal', 'large'].includes(value.fontSize) ||
        !Number.isInteger(value.intervalSeconds) || value.intervalSeconds < 1 || value.intervalSeconds > 60) {
      fail(422, '배경, 글자 크기 또는 전환 시간을 확인해 주세요.');
    }
    return {...result, background: value.background, fontSize: value.fontSize, intervalSeconds: value.intervalSeconds};
  }
  const displayText = text => text === null ? null : validate(text, 120, 2, true);

  function state(authorize = () => {}) {
    return tx(() => {
      authorize();
      const s = settings(), since = cutoff(), histories = new Map();
      for (const h of stmt(`SELECT h.* FROM memory_history h JOIN memories m ON m.id=h.memory_id
                            WHERE m.created_at>? AND h.created_at>? ORDER BY h.id DESC`).all(since, since)) {
        if (!histories.has(h.memory_id)) histories.set(h.memory_id, []);
        const items = histories.get(h.memory_id);
        if (items.length < HISTORY_LIMIT) items.push({id: h.id, displayText: h.display_text, createdAt: iso(h.created_at)});
      }
      return {
        eventId: EVENT_ID, ...event(), paused: !!s.paused, approval: !!s.approval, revision: s.revision,
        history: stmt('SELECT * FROM config_history WHERE event_id=? AND session=? AND created_at>? ORDER BY id DESC LIMIT ?')
          .all(EVENT_ID, activeSession(), since, HISTORY_LIMIT).map(h => ({id: h.id, createdAt: iso(h.created_at), config: JSON.parse(h.config)})),
        memories: stmt('SELECT * FROM memories WHERE created_at>? ORDER BY id DESC LIMIT 10000').all(since).map(row => ({
          id: row.id, session:row.session, text: row.text, nickname: row.nickname, displayText: row.display_text,
          status: row.status, version: row.version, createdAt: iso(row.created_at), history: histories.get(row.id) || [],
          question2: row.question2 ?? '', readAloud: row.read_aloud == null ? null : !!row.read_aloud,
          publicConsent: row.public_consent == null ? null : !!row.public_consent, creditConsent: !!row.credit_consent,
          consentPolicy: row.consent_policy ?? null, publicScope: consentScope(row),
        })),
      };
    });
  }

  function execute(action, body, authorize = () => {}) {
    // BEGIN IMMEDIATE serializes CAS with the independent SSH listener and CLI.
    // Preview/restore transactions perform no writes at all.
    return tx(() => {
      // Recheck under the write lock: a concurrent operator revocation cannot
      // slip between the HTTP session check and this transaction's mutation.
      authorize();
      if (['preview', 'publish', 'restore'].includes(action)) {
        const previous = eventVersion(body.version);
        if (action === 'restore') {
          positive(body.historyId);
          const h = stmt('SELECT config FROM config_history WHERE id=? AND event_id=? AND session=? AND created_at>?')
            .get(body.historyId, EVENT_ID, activeSession(), cutoff());
          if (!h) fail(404, '이전 설정을 찾을 수 없습니다.');
          return {version: previous.version, config: config(JSON.parse(h.config))};
        }
        const next = config(body.config);
        if (action === 'preview') return {version: previous.version, config: next};
        if (next.intervalSeconds !== previous.config.intervalSeconds) onInterval(previous.config.intervalSeconds);
        stmt('INSERT INTO config_history(event_id,config,created_at,session) VALUES(?,?,?,?)')
          .run(EVENT_ID, JSON.stringify(previous.config), Date.now(), activeSession());
        const changed = stmt('UPDATE event_config SET version=version+1,config=? WHERE event_id=? AND version=?')
          .run(JSON.stringify(next), EVENT_ID, body.version);
        if (changed.changes !== 1) fail(409, '행사 설정이 변경됐습니다.');
        stmt(`DELETE FROM config_history WHERE event_id=? AND session=? AND (created_at<=? OR id NOT IN
              (SELECT id FROM config_history WHERE event_id=? AND session=? ORDER BY id DESC LIMIT ?))`)
          .run(EVENT_ID, activeSession(), cutoff(), EVENT_ID, activeSession(), HISTORY_LIMIT);
        bump();
        return {ok: true, version: previous.version + 1};
      }
      if (['preview-memory', 'memory', 'restore-memory', 'moderate'].includes(action)) {
        const previous = memory(body.id, body.version);
        if (action === 'restore-memory') {
          positive(body.historyId);
          const h = stmt('SELECT display_text FROM memory_history WHERE id=? AND memory_id=? AND created_at>?')
            .get(body.historyId, body.id, cutoff());
          if (!h) fail(404, '이전 문구를 찾을 수 없습니다.');
          return {id: body.id, version: previous.version, text: h.display_text};
        }
        if (action === 'moderate') {
          if (body.status === 'delete') {
            if (body.confirmDelete !== true) fail(422, '영구 삭제 확인이 필요합니다.');
            // Same authorization and per-row CAS as edits/hiding, inside the
            // same write transaction. NO ACTION frozen FK goes first; history
            // is removed explicitly as well as protected by its CASCADE FK.
            removeFromScreen(body.id);
            // No personal text/identity in the tombstone; prevent retry resurrection.
            if (hasRetention) stmt('INSERT OR IGNORE INTO deleted_memory_requests(request_id) VALUES(?)').run(previous.request_id);
            stmt('DELETE FROM memory_history WHERE memory_id=?').run(body.id);
            const result = stmt('DELETE FROM memories WHERE id=? AND version=?').run(body.id, body.version);
            if (result.changes !== 1) fail(409, '다른 변경이 있습니다. 다시 불러와 확인해 주세요.');
            bump();
            return {ok: true, deletedId: body.id};
          }
          if (Object.hasOwn(body, 'confirmDelete')) fail(422, '삭제 확인은 영구 삭제에만 사용합니다.');
          if (!['pending', 'hidden', 'visible'].includes(body.status)) fail(422, '공개 상태를 확인해 주세요.');
          stmt('UPDATE memories SET status=?,published_at=?,version=version+1 WHERE id=? AND version=?')
            .run(body.status, body.status === 'visible' ? Date.now() : null, body.id, body.version);
          if (body.status !== 'visible') removeFromScreen(body.id);
        } else {
          const text = displayText(body.text);
          if (action === 'preview-memory') return {id: body.id, version: previous.version, text: text ?? previous.text};
          stmt('INSERT INTO memory_history(memory_id,display_text,created_at) VALUES(?,?,?)')
            .run(body.id, previous.display_text, Date.now());
          stmt('UPDATE memories SET display_text=?,version=version+1 WHERE id=? AND version=?')
            .run(text, body.id, body.version);
          stmt(`DELETE FROM memory_history WHERE memory_id=? AND (created_at<=? OR id NOT IN
                (SELECT id FROM memory_history WHERE memory_id=? ORDER BY id DESC LIMIT ?))`)
            .run(body.id, cutoff(), body.id, HISTORY_LIMIT);
        }
        bump();
        return {ok: true};
      }
      if (action === 'settings') {
        if (!Number.isSafeInteger(body.revision) || body.revision < 0 ||
            typeof body.paused !== 'boolean' || typeof body.approval !== 'boolean') fail(422, '설정을 확인해 주세요.');
        const old = settings();
        if (old.revision !== body.revision) fail(409, '다른 변경이 있습니다. 다시 불러와 확인해 주세요.');
        if (!old.paused && body.paused) {
          db.exec('DELETE FROM frozen');
          stmt(`INSERT INTO frozen(id) SELECT id FROM memories WHERE ${hasRetention ? PUBLIC_MEMORY_WHERE : "status='visible' AND created_at>?"}
                ORDER BY published_at DESC,id DESC LIMIT 100`).run(Date.now() - LEGACY_PUBLIC_MS);
        }
        if (!body.paused) db.exec('DELETE FROM frozen');
        if (!!old.paused !== body.paused) onPause(body.paused);
        stmt('UPDATE settings SET paused=?,approval=?,revision=revision+1 WHERE id=1 AND revision=?')
          .run(Number(body.paused), Number(body.approval), body.revision);
        return {ok: true};
      }
      fail(404, 'Not found');
    });
  }

  function cleanup() {
    tx(() => {
      // No age-based deletion of submissions, originals, consent or accounts.
      // Only legacy public consent has a seven-day window. New consent has none.
      db.exec('DELETE FROM frozen WHERE id NOT IN (SELECT id FROM memories)');
      stmt('DELETE FROM rates WHERE start<?').run(Date.now() - 3600000);
    });
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
  return {state, event, execute, cleanup};
}
