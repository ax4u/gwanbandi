import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes, randomUUID, createHmac, createHash, timingSafeEqual} from 'node:crypto';
import {readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, statSync, createReadStream} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {migrateClientSchema, createClientStore, transaction, pruneRollbackBackups} from './client-store.mjs';
import {CONSENT_POLICY, LEGACY_PUBLIC_MS, PUBLIC_MEMORY_WHERE, consentScope, migrateRetentionSchema} from './retention-policy.mjs';
import {createClientAdmin} from './client-admin.mjs';
import {migrateTheaterSchema, createTheaterStore} from './theater-store.mjs';

import {migrateEventSchema} from './event-revision.mjs';

import {createEventOperation} from './event-operation.mjs';
import {migrateSessionSchema} from './session-split.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const instanceId = randomUUID();
let snapshotSeq=0;
const PORT = Number(process.env.PORT || 18991), ADMIN_PORT = Number(process.env.ADMIN_PORT || 18992);
const publicUrl = process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}/jungang-memory/`;
const origin = new URL(publicUrl).origin;
const deletionContact=process.env.DELETION_CONTACT || '행사 운영자에게 직접 문의 (로컬 시험용)';
if (deletionContact.length>200 || /[<>\u0000-\u001f]/u.test(deletionContact)) throw Error('Invalid DELETION_CONTACT');
if (!['127.0.0.1','localhost','[::1]'].includes(new URL(publicUrl).hostname) && (new URL(publicUrl).protocol!=='https:' || !process.env.DELETION_CONTACT)) throw Error('Remote use requires HTTPS and DELETION_CONTACT');
if (!/^https?:$/.test(new URL(publicUrl).protocol) || new URL(publicUrl).pathname !== '/jungang-memory/' || new URL(publicUrl).search || new URL(publicUrl).hash || new URL(publicUrl).username || new URL(publicUrl).password) throw Error('Invalid PUBLIC_URL');
const dataDir = resolve(process.env.DATA_DIR || resolve(root, 'data'));
process.umask(0o077);
mkdirSync(dataDir, {recursive:true, mode:0o700}); chmodSync(dataDir, 0o700);
const secretPath = resolve(dataDir,'admin.key');
if (!existsSync(secretPath)) writeFileSync(secretPath, randomBytes(32).toString('base64url')+'\n', {mode:0o600, flag:'wx'});
chmodSync(secretPath,0o600);
const key = readFileSync(secretPath,'utf8').trim();
if (key.length < 40) throw Error('Invalid admin key');
const db = new DatabaseSync(resolve(dataDir,'memories.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), paused INTEGER NOT NULL DEFAULT 0, approval INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO settings(id) VALUES(1);
CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE, text TEXT NOT NULL, nickname TEXT NOT NULL, scene TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('visible','pending','hidden')), created_at INTEGER NOT NULL, published_at INTEGER);
CREATE INDEX IF NOT EXISTS memory_status ON memories(status,id);
CREATE TABLE IF NOT EXISTS frozen (id INTEGER PRIMARY KEY REFERENCES memories(id));
CREATE TABLE IF NOT EXISTS rates (bucket TEXT PRIMARY KEY, start INTEGER NOT NULL, count INTEGER NOT NULL);`);
if (db.prepare('PRAGMA user_version').get().user_version === 0) db.exec('PRAGMA user_version=1');
migrateClientSchema(db);
migrateTheaterSchema(db);
migrateEventSchema(db);
migrateRetentionSchema(db);
migrateSessionSchema(db);
chmodSync(resolve(dataDir,'memories.sqlite'),0o600);
const stmt = sql=>db.prepare(sql), settings=()=>stmt('SELECT * FROM settings WHERE id=1').get();
const bump=()=>stmt('UPDATE settings SET revision=revision+1 WHERE id=1').run();
const tx = fn => transaction(db, fn);
const clientStore = createClientStore(db, {validate, fail, onPause:paused=>operation.settingsChanged(paused), onInterval:old=>operation.intervalChanged(old)});
const theaterStore = createTheaterStore(db, {fail});
clientStore.cleanup();
pruneRollbackBackups(dataDir);
const cleanupTimer = setInterval(() => {
 try { clientStore.cleanup(); pruneRollbackBackups(dataDir); } catch { console.error('retention cleanup failed'); }
}, 60000);
cleanupTimer.unref();
const sessions = new Map();
const privateOrigins = new Set([`http://127.0.0.1:${ADMIN_PORT}`,`http://localhost:${ADMIN_PORT}`]);
const cookies=req=>Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim().split('='))); 
const hmac=x=>createHmac('sha256',key).update(x).digest('hex');
const equal=(a,b)=>{const x=Buffer.from(String(a)), y=Buffer.from(String(b));return x.length===y.length&&timingSafeEqual(x,y);};
const secure=origin.startsWith('https:') ? '; Secure' : '';
const csp="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'";
const screenCsp=csp+"; font-src 'self' data:; media-src 'none'; frame-src 'none'";
function send(req,res,status,data,type='application/json; charset=utf-8',extra={}) {
 const body=Buffer.isBuffer(data)?data:Buffer.from(type.startsWith('application/json')?JSON.stringify(data):data);
 res.writeHead(status,{'Content-Type':type,'Content-Length':body.length,'Cache-Control':'no-store','Content-Security-Policy':csp,'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Permissions-Policy':'camera=(), microphone=(), geolocation=(), payment=()','Cross-Origin-Resource-Policy':'same-origin','X-Jungang-App':'1',...extra});res.end(req.method==='HEAD'?undefined:body);
}
function fail(status,message) {const e=new Error(message);e.status=status;throw e;}
function rate(bucket,limit,windowMs=60000) {
 const now=Date.now(), name=hmac(bucket), r=stmt('SELECT * FROM rates WHERE bucket=?').get(name);
 if(!r||now-r.start>=windowMs) stmt('INSERT INTO rates(bucket,start,count) VALUES(?,?,1) ON CONFLICT(bucket) DO UPDATE SET start=excluded.start,count=1').run(name,now);
 else {if(r.count>=limit) fail(429,'잠시 후 다시 시도해 주세요.');stmt('UPDATE rates SET count=count+1 WHERE bucket=?').run(name);}
}
function client(req,res) {
 let id=cookies(req).jm_client;
 if(!/^[a-f0-9]{32}\.[a-f0-9]{64}$/.test(id||'') || !equal(id.split('.')[1],hmac('client:'+id.split('.')[0]))) {
 const value=randomBytes(16).toString('hex');id=value+'.'+hmac('client:'+value);
 res.setHeader('Set-Cookie',`jm_client=${id}; Path=/jungang-memory/; HttpOnly; SameSite=Strict; Max-Age=604800${secure}`);
 }
 return id.split('.')[0];
}
function readJson(req) {const max=4096;return new Promise((resolveBody,reject)=>{
 if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')) return reject(Object.assign(Error('JSON required'),{status:415}));
 let length=0, chunks=[]; req.on('data',c=>{length+=c.length;if(length>max){chunks=[];reject(Object.assign(Error('Too large'),{status:413}));}else chunks.push(c);});
 req.on('end',()=>{if(length>max)return;try{const b=JSON.parse(Buffer.concat(chunks).toString());if(!b||Array.isArray(b)||typeof b!=='object')throw Error();resolveBody(b);}catch{reject(Object.assign(Error('Invalid JSON'),{status:400}));}});
 req.on('error',reject);req.on('aborted',()=>reject(Object.assign(Error('Aborted'),{status:400})));
});}
function validate(value,max,min=0,preserveLines=false) {
 if(typeof value!=='string')fail(422,'문자열이 필요합니다.');
 if(/[<>\u0000-\u0008\u000b-\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value))fail(422,'허용되지 않는 문자입니다.');
 const normalized=value.normalize('NFC').replace(/\r\n?/g,'\n');
 const v=preserveLines ? normalized.trim() : normalized.replace(/\s+/gu,' ').trim();
 if([...v].length<min||[...v].length>max)fail(422,'글자 수를 확인해 주세요.');
 if(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/iu.test(v)||/(?:\+?82[\s.-]?)?0?1[016789][\s.-]?\d{3,4}[\s.-]?\d{4}/u.test(v))fail(422,'개인정보를 제외해 주세요.');
 return v;
}
function scene(text) {return /벚꽃|봄|꽃길/.test(text)?'blossom':/거리|밤|저녁|골목|별/.test(text)?'street':/영화|스크린|필름|상영|좌석/.test(text)?'screen':'marquee';}
const toPublic=row=>({id:row.id,text:row.text,nickname:row.nickname,scene:row.scene,createdAt:new Date(row.created_at).toISOString()});
function publicState() {
 return tx(() => {
  const sampledAt=Date.now(),t=operation.state(sampledAt),s = settings(), cutoff = sampledAt - LEGACY_PUBLIC_MS;
  const where = PUBLIC_MEMORY_WHERE + ' AND session=(SELECT session FROM theater_state WHERE id=1)' + (s.paused ? ' AND id IN (SELECT id FROM frozen)' : '');
  const rows = stmt(`SELECT * FROM memories WHERE ${where} ORDER BY published_at DESC,id DESC LIMIT 10000`).all(cutoff);
  const credits=theaterStore.credits();
  let validUntil=sampledAt+6000;
  if(t.operation.running){
   validUntil=Math.min(validUntil,operation.permitUntil());
   for(const row of rows)if(row.consent_policy!==CONSENT_POLICY)validUntil=Math.min(validUntil,row.created_at+LEGACY_PUBLIC_MS);
   for(const credit of credits)validUntil=Math.min(validUntil,Date.parse(credit.expiresAt));
  }
  return {
   ...clientStore.event(), revision:s.revision, paused:!!s.paused, approval:!!s.approval,
   theater:t, intakeSession:stmt('SELECT intake_session FROM session_control WHERE id=1').get().intake_session, credits, serverTime:new Date(sampledAt).toISOString(), displayHoldMs:6000, displayValidUntil:new Date(validUntil).toISOString(), instanceId, snapshotSeq:++snapshotSeq,
   memories:rows.map(row => toPublic({...row, text:row.display_text ?? row.text, scene:scene(row.display_text ?? row.text)})),
   total:stmt(`SELECT COUNT(*) AS n FROM memories WHERE ${where}`).get(cutoff).n,
  };
 });
}
const staticPublic=new Map([['/jungang-memory/','public/index.html'],['/jungang-memory/screen/','public/screen.html'],...['app.js','style.css','theater.js','theater.css'].map(x=>['/jungang-memory/'+x,'public/'+x]),...['NanumBrushScript-Regular.ttf','NanumBrushScript-OFL.txt','Pretendard-SemiBold.woff2','Pretendard-LICENSE.txt'].map(x=>['/jungang-memory/assets/'+x,'public/assets/'+x])]);
const staticAdmin=new Map([['/control/','admin/index.html'],['/control/assets/admin.js','admin/admin.js'],['/control/assets/admin.css','admin/admin.css']]);
const staticClient = new Map([
 ['/jungang-memory/manage/', 'client/index.html'],
 ['/jungang-memory/manage/client.js', 'client/client.js'],
 ['/jungang-memory/manage/client.css', 'client/client.css'],
 ['/jungang-memory/manage/event-console.js', 'client/event-console.js'],
]);
const operation = createEventOperation({db,fail});
staticPublic.set('/jungang-memory/event-player.js','public/event-player.js');
staticPublic.set('/jungang-memory/theater.css','public/story.css');
const handleClient = createClientAdmin({db, store:clientStore, operation, origin, readJson, send, fail});
const types={html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',json:'application/json; charset=utf-8',ttf:'font/ttf',woff2:'font/woff2',txt:'text/plain; charset=utf-8'};
function staticFile(req,res,file) {
 let content=readFileSync(resolve(root,file));
 if(file.endsWith('.html')) {
  content=content.toString().replaceAll('__DELETION_CONTACT__',deletionContact.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll("'",'&#39;'));
  if(file==='client/index.html'&&!bgmFile)content=content.replace(' src="'+readingBgmPath+'"','');
 }
 send(req,res,200,content,types[file.split('.').pop()],file==='public/screen.html'?{'Content-Security-Policy':screenCsp}:file==='client/index.html'?{'Content-Security-Policy':csp+"; font-src 'self' data:; media-src 'self'"}:{});}
const readingBgmPath='/jungang-memory/media/bgm/reading.mp3';
const bgmFile=process.env.BGM_FILE ? resolve(process.env.BGM_FILE) : null;
const bgmEtag=bgmFile ? '"'+createHash('sha256').update(readFileSync(bgmFile)).digest('hex')+'"' : null;
function readingBgm(req,res) {
 if(req.url!==readingBgmPath)fail(404,'Not found');
 if(!['GET','HEAD'].includes(req.method))fail(405,'Method not allowed');
 if(!bgmFile)fail(404,'No audio configured');
 const file=bgmFile,size=statSync(file).size;
 const etag=bgmEtag;
 let start=0,end=size-1,status=200;
 const headers={'Content-Type':'audio/mpeg','Accept-Ranges':'bytes','ETag':etag,'Cache-Control':'no-store','Content-Security-Policy':csp,'X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin','X-Jungang-App':'1'};
 if(req.method==='GET'&&req.headers.range&&(!req.headers['if-range']||req.headers['if-range']===etag)) {
  const m=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if(!m||(!m[1]&&!m[2]))return send(req,res,416,'','text/plain',{'Content-Range':`bytes */${size}`,'Accept-Ranges':'bytes'});
  if(m[1]) {start=Number(m[1]);end=m[2]?Math.min(Number(m[2]),size-1):size-1;}
  else {const suffix=Number(m[2]);start=Math.max(0,size-suffix);if(!Number.isSafeInteger(suffix)||suffix<=0)start=size;}
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=size||start>end)return send(req,res,416,'','text/plain',{'Content-Range':`bytes */${size}`,'Accept-Ranges':'bytes'});
  status=206;headers['Content-Range']=`bytes ${start}-${end}/${size}`;
 }
 headers['Content-Length']=end-start+1;res.writeHead(status,headers);
 if(req.method==='HEAD')return res.end();
 const stream=createReadStream(file,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
}
async function handlePublic(req,res) {
 const path=req.url.split('?')[0];
 if(path===readingBgmPath)return readingBgm(req,res);

 if (path.startsWith('/jungang-memory/manage/api/')) return handleClient(req,res);
 if ((req.method==='GET'||req.method==='HEAD') && path==='/jungang-memory/manage') {
  return send(req,res,308,'','text/plain',{'Location':'/jungang-memory/manage/'});
 }
 if ((req.method==='GET'||req.method==='HEAD') && staticClient.has(path)) return staticFile(req,res,staticClient.get(path));
 if(!['GET','HEAD','POST'].includes(req.method))fail(405,'Method not allowed');
 if(req.method==='POST') {
  if(path!=='/jungang-memory/api/memories')fail(404,'Not found');
  if(req.headers.origin!==origin)fail(403,'Origin not allowed');
  const id=client(req,res), ip=req.headers['x-jungang-ip']||req.socket.remoteAddress;
  // Both listeners are loopback-only; only our allowlisted relay supplies x-jungang-ip.
  rate('post-attempt-ip:'+ip,600);rate('post-attempt-client:'+id,30);
  const b=await readJson(req), text=validate(b.text,120,2,true), nickname=validate(b.nickname??'',16);
  const question2=validate(b.question2??'',500,0,true);
  if (typeof b.readAloud !== 'boolean' || b.publicConsent !== true) fail(422,'낭독 의사와 공개·보관 동의를 확인해 주세요.');
  const readAloud=Number(b.readAloud);
  const consentPolicy=b.consentPolicy === undefined ? null : b.consentPolicy;
  if (b.consentPolicy !== undefined && consentPolicy !== CONSENT_POLICY) fail(422,'공개·보관 동의 버전을 확인해 주세요.');
  if (b.creditConsent !== undefined && typeof b.creditConsent !== 'boolean') fail(422,'이름 공개 동의를 확인해 주세요.');
  const creditConsent = b.creditConsent === true ? 1 : 0;
  if(!/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(b.requestId||''))fail(422,'Invalid request id');
  const result=tx(()=>{
   const old=stmt('SELECT * FROM memories WHERE request_id=?').get(b.requestId);
   if(old){if(old.text!==text||old.nickname!==nickname||old.credit_consent!==creditConsent||old.question2!==question2||old.read_aloud!==readAloud||old.public_consent!==1||old.consent_policy!==consentPolicy||(b.session!==undefined&&old.session!==b.session))fail(409,'Request conflict');return {id:old.id,session:old.session,status:old.status==='visible'?'visible':'pending',duplicate:true,consentPolicy:old.consent_policy};}
   if(stmt('SELECT request_id FROM deleted_memory_requests WHERE request_id=?').get(b.requestId))fail(410,'삭제된 요청입니다. 다시 접수하지 않습니다.');
   // Old open forms/unconfirmed legacy requests must not acquire new consent.
   if(consentPolicy !== CONSENT_POLICY) fail(428,'페이지를 새로 열고 변경된 공개·보관 안내에 다시 동의해 주세요.');
   if(![1,2].includes(b.session)||b.session!==stmt('SELECT intake_session FROM session_control WHERE id=1').get().intake_session)fail(428,'접수 회차가 바뀌었습니다. 표시된 회차를 다시 확인하고 제출하세요.');
   rate('write-client:'+id,4);rate('write-ip:'+ip,240);rate('write-global',600);
   if(stmt('SELECT COUNT(*) AS n FROM memories').get().n>=10000)fail(503,'접수 한도에 도달했습니다.');
   // Only this newly consented request becomes screenable. Existing rows and
   // the administrator's later moderation (including hidden) remain untouched.
   const now=Date.now(), status='visible';
   const inserted=stmt('INSERT INTO memories(request_id,text,nickname,scene,status,created_at,published_at,credit_consent,question2,read_aloud,public_consent,consent_policy,session) VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?)').run(b.requestId,text,nickname,scene(text),status,now,status==='visible'?now:null,creditConsent,question2,readAloud,consentPolicy,b.session);bump();
   return {id:Number(inserted.lastInsertRowid),session:b.session,status,duplicate:false,consentPolicy};
  });
  return send(req,res,result.duplicate?200:201,result);
 }
 if(path==='/jungang-memory')return send(req,res,308,'', 'text/plain',{'Location':'/jungang-memory/'});
 if(path==='/jungang-memory/api/health')return send(req,res,200,{ok:true,app:'jungang-memory',schema:7,experience:'story-only-v1'});
 if(path==='/jungang-memory/api/config') {client(req,res);return send(req,res,200,{publicUrl,pollMs:1500,retentionDays:null,legacyPublicDays:7,consentPolicy:CONSENT_POLICY,storage:'until-deletion-request-or-admin-delete',deletionContact,maxText:120,maxNickname:16,maxQuestion2:500});}
 if(path==='/jungang-memory/api/state')return send(req,res,200,publicState());

 if(staticPublic.has(path))return staticFile(req,res,staticPublic.get(path));
 fail(404,'Not found');
}
function getSession(req) {const id=cookies(req).jm_admin,s=sessions.get(id);if(!s||s<Date.now()){sessions.delete(id);fail(401,'Authentication required');}return id;}
async function handleAdmin(req,res) {
 if(!privateOrigins.has('http://'+req.headers.host))fail(403,'Invalid private host');
 const path=req.url.split('?')[0];
 if(!['GET','HEAD','POST'].includes(req.method))fail(405,'Method not allowed');
 if(req.method!=='POST') {
  if(staticAdmin.has(path))return staticFile(req,res,staticAdmin.get(path));
  if(path==='/control/api/state') {
   getSession(req);
   const s = settings();
   const memories = stmt('SELECT * FROM memories ORDER BY id DESC LIMIT 10000')
    .all().map(row => ({...toPublic(row),status:row.status,publicScope:consentScope(row)}));
   return send(req,res,200,{paused:!!s.paused,approval:!!s.approval,memories});
  }
  fail(404,'Not found');
 }
 if(!privateOrigins.has(req.headers.origin)||req.headers['x-jungang-admin']!=='1')fail(403,'Private origin required');
 if(path==='/control/api/login') {
  rate('admin-login',5,60000); const b=await readJson(req);
  if(typeof b.key!=='string'||!equal(b.key,key))fail(401,'Invalid key');
  for(const [id,expiry] of sessions)if(expiry<Date.now())sessions.delete(id);
  if(sessions.size>=10)sessions.delete(sessions.keys().next().value);
  const id=randomBytes(32).toString('base64url');sessions.set(id,Date.now()+8*3600000);
  return send(req,res,200,{ok:true},undefined,{'Set-Cookie':`jm_admin=${id}; Path=/control/; HttpOnly; SameSite=Strict; Max-Age=28800`});
 }
 const sid=getSession(req),b=await readJson(req);
 if(path==='/control/api/logout'){sessions.delete(sid);return send(req,res,200,{ok:true},undefined,{'Set-Cookie':'jm_admin=; Path=/control/; HttpOnly; SameSite=Strict; Max-Age=0'});}
 if(path==='/control/api/settings') {
  if(typeof b.paused!=='boolean'||typeof b.approval!=='boolean')fail(422,'Boolean required');
  tx(() => {
   const old = settings();
   if(!old.paused && b.paused) {
    db.exec('DELETE FROM frozen');
    stmt(`INSERT INTO frozen(id) SELECT id FROM memories WHERE ${PUBLIC_MEMORY_WHERE} ORDER BY published_at DESC,id DESC LIMIT 100`)
     .run(Date.now()-LEGACY_PUBLIC_MS);
   }
   if(!b.paused) db.exec('DELETE FROM frozen');
   if(!!old.paused!==b.paused)operation.settingsChanged(b.paused);
   stmt('UPDATE settings SET paused=?,approval=?,revision=revision+1 WHERE id=1')
    .run(Number(b.paused),Number(b.approval));
  });
  return send(req,res,200,{ok:true});
 }
 if(path==='/control/api/moderate') {
  if(!Number.isSafeInteger(b.id)||b.id<1||!['hidden','visible'].includes(b.status))fail(422,'Invalid moderation');
  tx(() => {
   const old = stmt('SELECT id FROM memories WHERE id=?').get(b.id);
   if(!old) fail(404,'Not found');
   // Legacy SSH requests do not carry a version, but must invalidate stale web drafts.
   stmt('UPDATE memories SET status=?,published_at=?,version=version+1 WHERE id=?')
    .run(b.status,b.status==='visible'?Date.now():null,b.id);
   if(b.status==='hidden') stmt('DELETE FROM frozen WHERE id=?').run(b.id);
   bump();
  });
  return send(req,res,200,{ok:true});
 }
 fail(404,'Not found');
}
let stopping = false;
const inFlight = new Set();
function server(handler,port) {const s=http.createServer({maxHeaderSize:8192},(req,res)=>{
 if (stopping) return send(req,res,503,{error:'서버가 종료 중입니다.'},undefined,{'Connection':'close'});
 const work=handler(req,res).catch(e=>{
  if(!res.destroyed) {
   if(!res.headersSent)send(req,res,e.status||500,{error:e.status?e.message:'서버 오류입니다. 잠시 후 다시 시도해 주세요.'},undefined,e.status===429?{'Retry-After':'60'}:{});
   else res.destroy();
  }
  if(!e.status)console.error('request failure',e.code||e.name);
 });
 inFlight.add(work);work.finally(()=>inFlight.delete(work));
});s.requestTimeout=190000;s.headersTimeout=10000;s.keepAliveTimeout=5000;s.maxRequestsPerSocket=100;s.on('clientError',(_e,socket)=>socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));s.listen(port,'127.0.0.1',()=>console.log(`gwanbandi listening loopback:${port}`));return s;}
const pub=server(handlePublic,PORT), admin=server(handleAdmin,ADMIN_PORT);
async function stop(){
 if(stopping)return;
 stopping=true;clearInterval(cleanupTimer);
 // Socket closure alone does not imply an async upload's commit/finally ended.
 await Promise.all([pub,admin].map(s=>new Promise(resolve=>s.close(resolve))));
 await Promise.allSettled([...inFlight]);
 db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();
}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
