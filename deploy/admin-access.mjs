import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
if (!process.stdout.isTTY || !process.stdin.isTTY) {console.error('관리 키는 인증된 대화형 SSH 터미널에서만 확인할 수 있습니다. 채팅/로그/파이프 출력 금지.'); process.exit(1);}
const port=Number(process.env.ADMIN_PORT||18992);
console.log(`SSH 포워딩: 로컬 ${port} → 서버 127.0.0.1:${port} (Local only).`);
console.log(`브라우저: http://127.0.0.1:${port}/control/`);
console.log('아래 키를 위 로컬 로그인 폼에만 입력하세요. URL·채팅·화면공유 금지.');
console.log(readFileSync(resolve(process.env.DATA_DIR || fileURLToPath(new URL('../data/',import.meta.url)), 'admin.key'),'utf8').trim());
