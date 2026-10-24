import {transaction} from './client-store.mjs';
import {consentScope} from './retention-policy.mjs';

// Additive, transactional v4 -> v5. Existing consent is UNKNOWN, not retroactive.
// No automatic downgrade: v4 cleanup would delete retained data and library files.
export function migrateEventSchema(db) {
  transaction(db, () => {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if ([5,6,7].includes(version)) return;
    if (version !== 4) throw Error('Expected schema 4');
    db.exec(`ALTER TABLE memories ADD COLUMN question2 TEXT NOT NULL DEFAULT '';
      ALTER TABLE memories ADD COLUMN read_aloud INTEGER DEFAULT NULL CHECK(read_aloud IS NULL OR read_aloud IN (0,1));
      ALTER TABLE memories ADD COLUMN public_consent INTEGER DEFAULT NULL CHECK(public_consent IS NULL OR public_consent IN (0,1));
      ALTER TABLE theater_state ADD COLUMN cue INTEGER DEFAULT NULL CHECK(cue IS NULL OR cue BETWEEN 1 AND 17);
      ALTER TABLE theater_state ADD COLUMN session INTEGER NOT NULL DEFAULT 1 CHECK(session IN (1,2));
      ALTER TABLE theater_state ADD COLUMN cue_bgm TEXT NOT NULL DEFAULT '{}';
      PRAGMA user_version=5;`);
  });
}

// Quote every cell and neutralize spreadsheet formula prefixes, including controls
// and whitespace before a prefix. Original DB text is never altered by export.
export function csvCell(value) {
  let s = String(value ?? '');
  if (/^[\s\u0000-\u001f\u007f]*[=+\-@]/u.test(s) || /^[\t\r\n]/u.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
export function exportMemories(db, authorize) {
  return transaction(db, () => {
    authorize();
    const rows = [['번호','원문','검수문구','실제상영문구','검수상태','작성시각(UTC)','별명','질문2','낭독의사','공개·보관동의','크레딧동의','공개정책버전','공개동의범위','회차']];
    const answer = x => x === null || x === undefined ? '미응답(기존 기록)' : x ? '네' : '아니오';
    for (const m of db.prepare('SELECT * FROM memories ORDER BY id').all()) rows.push([
      m.id,m.text,m.display_text,m.display_text ?? m.text,
      {pending:'대기',visible:'상영 가능',hidden:'상영 불가'}[m.status],
      new Date(m.created_at).toISOString(),m.nickname,m.question2,answer(m.read_aloud),answer(m.public_consent),answer(m.credit_consent),
      m.consent_policy ?? '기존 동의(버전 미기록)',consentScope(m),m.session??'미분류',
    ]);
    return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  });
}
