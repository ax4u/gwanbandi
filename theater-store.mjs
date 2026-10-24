import {transaction, RETENTION_MS} from './client-store.mjs';
import {CONSENT_POLICY, LEGACY_PUBLIC_MS, PUBLIC_MEMORY_WHERE} from './retention-policy.mjs';

const MODES = ['opening','memory','story','ending'];

// v4 only widens theater_state's CHECK. Rebuild that one table atomically;
// copy every state field verbatim, never replace submissions or other data.
// v2 still adds opt-in consent with the original default: no retroactive consent.
export function migrateTheaterSchema(db) {
  transaction(db, () => {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if ([4,5,6,7].includes(version)) return;
    if (version !== 2 && version !== 3) throw Error('Expected client schema 2 or theater schema 3');
    if (version === 2) db.exec('ALTER TABLE memories ADD COLUMN credit_consent INTEGER NOT NULL DEFAULT 0 CHECK(credit_consent IN (0,1))');
    db.exec(`CREATE TABLE theater_state_v4 (
      id INTEGER PRIMARY KEY CHECK(id=1),
      mode TEXT NOT NULL DEFAULT 'opening' CHECK(mode IN ('opening','memory','story','ending')),
      revision INTEGER NOT NULL DEFAULT 0,
      credits_run INTEGER NOT NULL DEFAULT 0,
      story_id INTEGER
    )`);
    if (version === 3) db.exec(`
      INSERT INTO theater_state_v4(id,mode,revision,credits_run,story_id)
        SELECT id,mode,revision,credits_run,story_id FROM theater_state;
      DROP TABLE theater_state;
    `);
    else db.exec('INSERT INTO theater_state_v4(id) VALUES(1)');
    db.exec('ALTER TABLE theater_state_v4 RENAME TO theater_state; PRAGMA user_version=4;');
  });
}

// Offline v4 -> v3 only. An active memory scene has no v3 equivalent: refuse
// rather than silently changing it or restoring an obsolete database snapshot.
// An operator must explicitly choose a v3-compatible scene before stopping v4.
export function rollbackProjectorSchema(db) {
  transaction(db, () => {
    if (db.prepare('PRAGMA user_version').get().user_version !== 4) throw Error('Expected projector schema 4');
    if (db.prepare('SELECT mode FROM theater_state WHERE id=1').get()?.mode === 'memory') {
      throw Error('Cannot roll back active memory mode; explicitly choose opening, story or ending first');
    }
    db.exec(`CREATE TABLE theater_state_v3 (
      id INTEGER PRIMARY KEY CHECK(id=1),
      mode TEXT NOT NULL DEFAULT 'opening' CHECK(mode IN ('opening','story','ending')),
      revision INTEGER NOT NULL DEFAULT 0,
      credits_run INTEGER NOT NULL DEFAULT 0,
      story_id INTEGER
    );
    INSERT INTO theater_state_v3(id,mode,revision,credits_run,story_id)
      SELECT id,mode,revision,credits_run,story_id FROM theater_state;
    DROP TABLE theater_state;
    ALTER TABLE theater_state_v3 RENAME TO theater_state;
    PRAGMA user_version=3;`);
  });
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

// Offline only. Never restore an old DB over newer submissions/accounts/history.
export function rollbackTheaterSchema(db) {
  if (db.prepare('PRAGMA user_version').get().user_version !== 3) throw Error('Expected theater schema 3');
  transaction(db, () => db.exec(`DROP TABLE theater_state;
    ALTER TABLE memories DROP COLUMN credit_consent;
    PRAGMA user_version=2;`));
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

export function createTheaterStore(db, {fail, now = Date.now, hasTrack = () => false,defaultVersion=()=>null}) {
  const stmt = sql => db.prepare(sql);
  const hasRetention = stmt('PRAGMA user_version').get().user_version >= 6;
  const eligible = () => {
    const paused = stmt('SELECT paused FROM settings WHERE id=1').get().paused;
    return stmt(`SELECT id FROM memories WHERE ${hasRetention ? PUBLIC_MEMORY_WHERE : "status='visible' AND created_at>?"}${paused ? ' AND id IN (SELECT id FROM frozen)' : ''}
      ORDER BY published_at DESC,id DESC LIMIT 100`).all(now() - LEGACY_PUBLIC_MS).map(row => row.id);
  };
  function state() {
    const row = stmt('SELECT * FROM theater_state WHERE id=1').get();
    return {mode:row.mode, revision:row.revision, creditsRun:row.credits_run,
      ...(row.cue_bgm === undefined ? {} : {cue:row.cue, session:row.session, cueBgm:JSON.parse(row.cue_bgm)}),
      storyId:row.story_id !== null && eligible().includes(row.story_id) ? row.story_id : null};
  }
  function credits() {
    const time = now(), day = 86400000, offset = 9 * 3600000;
    const start = Math.floor((time + offset) / day) * day - offset;
    // Same NFC/trimmed display name appears once, in first-submission order.
    // Consent is per submission, not identity. No fake name or real-name lookup.
    return stmt(`SELECT nickname AS name, MIN(created_at) AS first,
      MIN(CASE WHEN consent_policy=? THEN ? ELSE created_at+? END) AS valid_until FROM memories
      WHERE ${PUBLIC_MEMORY_WHERE} AND credit_consent=1 AND nickname<>'' AND session=(SELECT session FROM theater_state WHERE id=1)
      GROUP BY nickname ORDER BY first,MIN(id)`).all(CONSENT_POLICY,time+6000,LEGACY_PUBLIC_MS,time-LEGACY_PUBLIC_MS)
      .map(row => ({name:row.name, expiresAt:new Date(Math.min(time+6000,row.valid_until)).toISOString()}));
  }
  function execute(body, authorize) {
    return transaction(db, () => {
      authorize();
      const commands = [...MODES,'next','back','restart-credits','next-story','previous-story','select-cue','next-cue','previous-cue','session','cue-bgm'];
      if (!Number.isSafeInteger(body.revision) || body.revision < 0 || !commands.includes(body.command)) fail(422,'상영 명령을 확인해 주세요.');
      const current = state();
      if (current.revision !== body.revision) fail(409,'상영 단계가 바뀌었습니다. 다시 확인해 주세요.');
      let mode = current.mode, storyId = current.storyId, run = current.creditsRun;
      let cue = current.cue, session = current.session;
      const cueBgm = {...current.cueBgm};
      // Latest 16-slide notes place selected audience stories at 10 and 13.
      const cueMode = n => [9,10].includes(n) ? 'story' : n === 15 ? 'ending' : 'opening';
      if (['select-cue','next-cue','previous-cue','session','cue-bgm'].includes(body.command)) {
        if (current.cueBgm === undefined) fail(409,'행사 큐 스키마가 필요합니다.');
        if (body.command === 'session') {
          if (![1,2].includes(body.session)) fail(422,'회차를 선택해 주세요.');
          session = body.session; if (cue >= 16) cue = 16;
        } else if (body.command === 'cue-bgm') {
          if (!(Number.isInteger(body.cue) && body.cue >= 1 && body.cue <= 16) && !MODES.includes(body.cue)) fail(422,'음악 대상 큐를 확인해 주세요.');
          const choice=body.bgm;
          if (!choice || !['default','track','silent'].includes(choice.mode) || Object.keys(choice).some(k => !['mode','version'].includes(k))) fail(422,'음악 설정을 확인해 주세요.');
          if (choice.mode === 'track' && (typeof choice.version !== 'string' || !hasTrack(choice.version))) fail(422,'서버 음원을 선택해 주세요.');
          if (choice.mode !== 'track' && choice.version != null) fail(422,'음원 버전은 지정곡에만 사용합니다.');
          const defaultTrack=defaultVersion();
          cueBgm[String(body.cue)]=choice.mode==='default'?(defaultTrack?{mode:'track',version:defaultTrack}:{mode:'silent',version:null}):{mode:choice.mode,version:choice.mode === 'track' ? choice.version : null};
        } else {
          const order=[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16];
          if (body.command === 'select-cue') {
            if (!Number.isInteger(body.cue) || body.cue < 1 || body.cue > 16) fail(422,'큐 번호를 확인해 주세요.');
            cue=body.cue;
          } else cue=order[Math.max(0,Math.min(order.length-1,order.indexOf(cue)+(body.command === 'next-cue' ? 1 : -1)))];
        }
        if (cue != null) mode=cueMode(cue);
      } else if (![ 'next-story','previous-story','restart-credits'].includes(body.command)) cue=null;
      const modes = MODES;
      if (modes.includes(body.command)) mode = body.command;
      if (body.command === 'next') mode = modes[Math.min(modes.length-1,modes.indexOf(mode)+1)];
      if (body.command === 'back') mode = modes[Math.max(0,modes.indexOf(mode)-1)];
      if (body.command === 'restart-credits') run++;
      if (['next-story','previous-story'].includes(body.command)) {
        if (cue != null && ![10,13].includes(cue)) cue=null;
        const ids = eligible();
        const index = ids.indexOf(storyId);
        storyId = ids.length ? ids[(Math.max(0,index) + (body.command === 'next-story' ? 1 : -1) + ids.length) % ids.length] : null;
        mode = 'story';
      }
      if (mode === 'story' && storyId === null) storyId = eligible()[0] ?? null;
      if (mode === 'ending' && current.mode !== 'ending') run++;
      stmt('UPDATE theater_state SET mode=?,story_id=?,credits_run=?,revision=revision+1 WHERE id=1 AND revision=?')
        .run(mode,storyId,run,body.revision);
      if (current.cueBgm !== undefined) stmt('UPDATE theater_state SET cue=?,session=?,cue_bgm=? WHERE id=1').run(cue,session,JSON.stringify(cueBgm));
      return {ok:true,theater:state()};
    });
  }
  return {state,credits,execute};
}
