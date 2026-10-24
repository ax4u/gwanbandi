// Story consent only. Account/session/rate/token lifetimes are unrelated.
export const CONSENT_POLICY = 'jungang-story-unlimited-v1';
export const LEGACY_PUBLIC_MS = 7 * 86400000;
// A policy marker alone is insufficient. NULL legacy consent is left as recorded;
// explicit refusal and unknown policies fail closed. Hidden/pending always stay out.
export const PUBLIC_MEMORY_WHERE = `status='visible' AND (public_consent IS NULL OR public_consent=1)
  AND ((public_consent=1 AND consent_policy='${CONSENT_POLICY}') OR (consent_policy IS NULL AND created_at>?))`;
export function consentScope(row) {
  if (row.consent_policy === CONSENT_POLICY && row.public_consent === 1) return '기간 제한 없음(신규 동의)';
  if (row.consent_policy == null && row.public_consent !== 0) return '기존 동의: 작성 후 7일 공개';
  return '공개 동의 확인 필요(비공개)';
}
export function migrateRetentionSchema(db) {
  // Caller has completed v5 migration; no rewrite of existing rows or consent.
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version !== 6 && version !== 7) {
      if (version !== 5) throw Error('Expected schema 5');
      db.exec(`ALTER TABLE memories ADD COLUMN consent_policy TEXT DEFAULT NULL
        CHECK(consent_policy IS NULL OR consent_policy='${CONSENT_POLICY}');
        CREATE TABLE deleted_memory_requests (request_id TEXT PRIMARY KEY);
        PRAGMA user_version=6;`);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
