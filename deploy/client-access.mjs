import {DatabaseSync} from 'node:sqlite';
import {existsSync, openSync, closeSync, fstatSync, writeSync} from 'node:fs';
import {isatty} from 'node:tty';
import {Writable} from 'node:stream';
import {createInterface} from 'node:readline/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {issueClientAccount, issueShortClientAccount, unlockShortClientAccount, revokeClientAccount, SHORT_ACCOUNT_POLICY} from '../client-admin.mjs';
import {EVENT_ID} from '../client-store.mjs';

// No credentials/handles in argv or environment; no secret files or logs. Short
// passwords are entered twice without echo, never displayed (not even on TTY).
// Legacy issue/rotate retain their explicit one-time TTY-only random credential
// delivery. Never run under terminal recording, screen sharing or a chat relay.
const action = process.argv[2];
if (process.argv.length !== 3 || !['issue', 'rotate', 'revoke', 'issue-short', 'unlock'].includes(action)) {
  console.error('사용법: node deploy/client-access.mjs issue-short|revoke|unlock|issue|rotate (비밀 인자 금지)');
  process.exit(1);
}
if (![0, 1, 2].every(isatty) || !process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY) {
  console.error('실제 운영자 대화형 터미널이 필요합니다. 파이프·로그·채팅 출력은 금지합니다.');
  process.exit(1);
}
let tty, db, prompts, hidden = false;
try {
  tty = openSync('/dev/tty', 'r+');
  if (!isatty(tty) || !fstatSync(tty).isCharacterDevice()) throw Error('TTY required');
  const dataDir = resolve(process.env.DATA_DIR || fileURLToPath(new URL('../data/', import.meta.url)));
  const path = resolve(dataDir, 'memories.sqlite');
  if (!existsSync(path)) throw Error('Initialized database required');
  process.umask(0o077);
  db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON; PRAGMA foreign_keys=ON;');
  if (![2,3,4,5,6,7].includes(db.prepare('PRAGMA user_version').get().user_version)) throw Error('Expected client schema 2 through 7');
  const output = new Writable({write(chunk, _encoding, done) {
    if (!hidden) writeSync(tty, chunk);
    done();
  }});
  output.isTTY = true;
  output.columns = process.stdout.columns || 80;
  // readline's terminal mode disables the kernel echo; the output gate also
  // suppresses its own redisplay, cursor controls, paste and history echo.
  prompts = createInterface({input: process.stdin, output, terminal: true, historySize: 0});
  const abort = new AbortController();
  prompts.on('SIGINT', () => abort.abort());
  prompts.on('close', () => abort.abort());
  const ask = question => prompts.question(question, {signal: abort.signal});
  const secret = async () => {
    hidden = true;
    // Remain muted until close, including on mismatch/abort. Late pasted input
    // must never be echoed after a secret question resolves.
    writeSync(tty, '새 암호 (공백 없는 ASCII 1~5자, 표시 안 함): ');
    let first = await ask('');
    writeSync(tty, '\n새 암호 다시 입력 (표시 안 함): ');
    let second = await ask('');
    writeSync(tty, '\n');
    if (first !== second) throw Error('Password confirmation mismatch');
    second = '';
    const result = first;
    first = '';
    return result;
  };
  writeSync(tty, `고정 행사: ${EVENT_ID}\n터미널 녹화·화면공유·채팅 전송 금지. 수신자 본인과 권한을 별도 확인하세요.\n`);
  const confirmed = await ask('확인된 수신자에게만 직접 전달하며 터미널이 기록되지 않습니까? "확인" 입력: ');
  if (confirmed !== '확인') throw Error('Operator confirmation required');
  const username = action === 'issue' ? undefined : await ask('비개인 행사 ID (짧은 계정: 영문·숫자 1~5자, 대소문자 구분): ');
  if (action === 'revoke') {
    revokeClientAccount(db, username);
    if (db.prepare('SELECT enabled FROM client_accounts WHERE username=?').get(username)?.enabled !== 0) throw Error('Readback failed');
    writeSync(tty, '계정을 중지했습니다. 기존 웹 세션은 다음 요청부터 거부됩니다.\n');
  } else if (action === 'issue-short' || action === 'unlock') {
    writeSync(tty, '주의: 5자 이하 암호는 추측 공격을 완전히 방어할 수 없습니다. 중요·장기 계정에 사용하지 마세요.\n');
    writeSync(tty, '실패·미완료 합계 5회면 지속 잠금, 15분간 계정 5회·IP 10회·전체 30회 제한. 재시작해도 유지됩니다.\n');
    let expiresAt;
    if (action === 'issue-short') {
      const hours = await ask(`유효 시간 (정수 1~8, 권장 ${SHORT_ACCOUNT_POLICY.recommendedHours}시간, 기본값 없음): `);
      if (!/^[1-8]$/.test(hours)) throw Error('Invalid expiry');
      expiresAt = Date.now() + Number(hours) * 3600000;
    } else {
      const confirmation = await ask('중지된 짧은 계정만 새 암호로 해제합니다. 만료는 연장되지 않습니다. "해제" 입력: ');
      if (confirmation !== '해제') throw Error('Unlock confirmation required');
    }
    let password = await secret();
    let credentials;
    try {
      credentials = action === 'issue-short' ? await issueShortClientAccount(db, {username, password, expiresAt}) :
        await unlockShortClientAccount(db, {username, password});
    } finally { password = ''; }
    const saved = db.prepare('SELECT enabled,expires_at,event_id FROM client_accounts WHERE username=?').get(username);
    if (!saved || saved.enabled !== 1 || saved.event_id !== EVENT_ID || saved.expires_at !== credentials.expiresAt) throw Error('Readback failed');
    writeSync(tty, `짧은 행사 계정 ${action === 'unlock' ? '해제' : '발급'} 완료. 암호는 표시하지 않습니다.\n만료: ${new Date(credentials.expiresAt).toISOString()}\n공식 /jungang-memory/manage/ 로그인에만 사용하세요.\n`);
  } else {
    const input = await ask('지금부터 유효한 시간 (정수 1~168): ');
    if (!/^[1-9]\d{0,2}$/.test(input) || Number(input) > 168) throw Error('Invalid expiry');
    const credentials = await issueClientAccount(db, {
      expiresAt: Date.now() + Number(input) * 3600000,
      ...(action === 'rotate' ? {rotateUsername: username} : {}),
    });
    const saved = db.prepare('SELECT enabled,expires_at,event_id FROM client_accounts WHERE username=?').get(credentials.username);
    if (!saved || saved.enabled !== 1 || saved.event_id !== EVENT_ID || saved.expires_at !== credentials.expiresAt) throw Error('Readback failed');
    writeSync(tty, `계정: ${credentials.username}\n일회 표시 접근 암호: ${credentials.password}\n만료: ${new Date(credentials.expiresAt).toISOString()}\n공식 /jungang-memory/manage/ 로그인에만 사용하세요. SSH 키와 무관합니다.\n`);
  }
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
} catch {
  // Never print exception input, SQL values or credentials.
  console.error('작업을 완료하지 못했습니다. 터미널·입력·스키마·계정 상태를 확인하세요.');
  process.exitCode = 1;
} finally {
  prompts?.close();
  db?.close();
  if (tty !== undefined) closeSync(tty);
}
