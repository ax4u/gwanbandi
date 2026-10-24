import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {mkdtempSync, mkdirSync, readFileSync, statSync, rmSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {issueClientAccount} from '../client-admin.mjs';
import {CONSENT_POLICY} from '../retention-policy.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),base='/jungang-memory/',api=base+'manage/api/';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){const s=createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;}

test('isolated synthetic intake, moderation, sessions and presentation', {timeout:60000}, async t=>{
 const tempRoot=process.env.TMPDIR||resolve(root,'.test-tmp');mkdirSync(tempRoot,{recursive:true});
 const temp=mkdtempSync(join(tempRoot,'gwanbandi-test-')),data=join(temp,'data');
 const port=await freePort();let adminPort=await freePort();while(adminPort===port)adminPort=await freePort();
 assert(![8791,8792,18991,18992].includes(port));assert(![8791,8792,18991,18992].includes(adminPort));
 const origin=`http://127.0.0.1:${port}`;let proc,cookie='',serverLog='';
 async function raw(path,body,extra={},useCookie=true){return fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Jungang-Client':'1',...(useCookie?{Cookie:cookie}:{}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000)});}
 async function req(path,body,status=200,extra={},useCookie=true){const r=await raw(path,body,extra,useCookie);assert.equal(r.status,status,path);return r.status===204?null:r.json();}
 async function start(){
  proc=spawn(process.execPath,['server.mjs'],{cwd:root,env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:tempRoot,PORT:String(port),ADMIN_PORT:String(adminPort),DATA_DIR:data,PUBLIC_URL:origin+base,DELETION_CONTACT:'합성시험 운영자'},stdio:['ignore','pipe','pipe']});
  proc.stdout.on('data',v=>serverLog+=v);proc.stderr.on('data',v=>serverLog+=v);
  for(let i=0;i<100;i++){if(proc.exitCode!==null)throw Error('Isolated server exited');try{await req(base+'api/health');return;}catch{}await sleep(40);}throw Error('Isolated server readiness timeout');
 }
 async function stop(){if(proc&&proc.exitCode===null){const done=once(proc,'exit');proc.kill('SIGTERM');await done;}}
 const detail=()=>req(api+'operation');
 async function cmd(command,values={}){const d=await detail();return req(api+'operation',{revision:d.theater.revision,command,...values});}
 const publicState=()=>req(base+'api/state');
 let credentials,story,submission;
 try{
  await start();
  await t.test('fresh DB schema, empty state, neutral assets and private boundary',async()=>{
   const db=new DatabaseSync(join(data,'memories.sqlite'));assert.equal(db.prepare('PRAGMA user_version').get().user_version,7);assert.equal(db.prepare('SELECT COUNT(*) n FROM client_accounts').get().n,0);
   credentials=await issueClientAccount(db,{expiresAt:Date.now()+3600000});db.close();
   assert.equal(statSync(data).mode&0o777,0o700);assert.equal(statSync(join(data,'admin.key')).mode&0o777,0o600);
   assert.equal((await publicState()).memories.length,0);assert.equal((await publicState()).theater.operation.running,false);
   for(const p of ['state','operation','export','presenter'])await req(api+p,undefined,401,{},false);
   assert.equal((await raw('/control/')).status,404);assert.equal((await raw(base+'data/admin.key')).status,404);
   assert.equal((await raw(base+'media/bgm/reading.mp3')).status,404);
   for(const p of ['theater-memory.png','story-paper.png','reading-five-pptx.jpg','participate-qr.svg'])assert.equal((await raw(base+'assets/'+p)).status,404);
   const html=await (await raw(base)).text();assert(html.includes('관객-반응-디피 시스템'));assert(html.includes('합성시험 운영자'));assert(!html.includes('__DELETION_CONTACT__'));
   const manage=await(await raw(base+'manage/')).text();assert(!manage.includes('src="'+base+'media/'));assert(!manage.includes('claude.ai'));
  });
  await t.test('real login, Secure/HttpOnly/Strict cookie and origin/header checks',async()=>{
   const login=await raw(api+'login',credentials.username?{username:credentials.username,password:credentials.password}:{}, {},false);
   assert.equal(login.status,200);const set=login.headers.get('set-cookie');assert.match(set,/^__Secure-jm_event=/);assert.match(set,/Secure; HttpOnly; SameSite=Strict/);cookie=set.split(';')[0];
   await req(api+'state');const d=await detail();
   await req(api+'operation',{command:'start',revision:d.theater.revision},403,{Origin:'https://invalid.example'});
   await req(api+'operation',{command:'start',revision:d.theater.revision},403,{'X-Jungang-Client':'0'});
   await req(api+'operation',{command:'start',revision:d.theater.revision},401,{},false);
   const cli=spawnSync(process.execPath,['deploy/client-access.mjs','issue'],{cwd:root,env:{PATH:process.env.PATH,DATA_DIR:data},encoding:'utf8'});assert.equal(cli.status,1);assert.match(cli.stderr,/대화형 터미널/);assert.equal(cli.stdout,'');
   assert(readFileSync(join(root,'deploy/client-access.mjs'),'utf8').includes('[2,3,4,5,6,7].includes'));
  });
  await t.test('consent, input rejection, idempotency and private response fields',async()=>{
   submission={requestId:randomUUID(),text:'합성 관객의 첫 이야기\n줄바꿈 유지',nickname:'합성관객',question2:'비공개 합성 응답',readAloud:true,publicConsent:true,creditConsent:true,consentPolicy:CONSENT_POLICY,session:1};
   await req(base+'api/memories',{...submission,publicConsent:false},422);
   await req(base+'api/memories',{...submission,consentPolicy:undefined},428);
   await req(base+'api/memories',{...submission,text:'<script>합성</script>'},422);
   await req(base+'api/memories',{...submission,text:'sample@example.com'},422);
   story=await req(base+'api/memories',submission,201);assert.equal(story.status,'visible');
   assert.equal((await req(base+'api/memories',submission)).duplicate,true);
   const p=await publicState();assert.equal(p.memories[0].text,submission.text);assert(!Object.hasOwn(p.memories[0],'question2'));assert(!Object.hasOwn(p.memories[0],'readAloud'));
   const s=await req(api+'state');assert.equal(s.memories[0].question2,submission.question2);
  });
  await t.test('moderation hides pending/hidden, preserves original and defeats stale writes',async()=>{
   const memory=async()=> (await req(api+'state')).memories.find(m=>m.id===story.id);
   let m=await memory();await req(api+'memory',{id:m.id,version:m.version,text:'합성 검수 표시문구'});m=await memory();assert.equal(m.text,submission.text);assert.equal(m.displayText,'합성 검수 표시문구');
   for(const status of ['pending','hidden']){m=await memory();await req(api+'moderate',{id:m.id,version:m.version,status});assert.equal((await publicState()).memories.length,0);assert.equal((await publicState()).credits.length,0);}
   await req(base+'api/memories',submission);assert.equal((await memory()).status,'hidden');
   m=await memory();await req(api+'moderate',{id:m.id,version:m.version,status:'visible'});await req(api+'moderate',{id:m.id,version:m.version,status:'hidden'},409);
   assert.equal((await publicState()).memories[0].text,'합성 검수 표시문구');
  });
  await t.test('random interval 1–60, revision CAS, pause and manual reading',async()=>{
   assert.equal((await detail()).theater.operation.intervalSeconds,3);
   // Independent synthetic browsers get their own signed cookie; no shared-client budget bypass.
   for(let i=0;i<6;i++)await req(base+'api/memories',{...submission,requestId:randomUUID(),text:`합성 낭독 이야기 ${i}`,nickname:`가상관객${i}`,creditConsent:false},201,{},false);
   for(const intervalSeconds of [0,61,1.5,'3']){const d=await detail();await req(api+'operation',{revision:d.theater.revision,version:d.configVersion,command:'random-interval',intervalSeconds},422);}
   let d=await detail();await cmd('random-interval',{version:d.configVersion,intervalSeconds:1});assert.equal((await detail()).theater.operation.running,false);
   await cmd('start');const first=(await detail()).theater.storyId;await sleep(1100);assert.notEqual((await detail()).theater.storyId,first);
   await cmd('pause');d=await detail();const held=d.theater.storyId;await cmd('random-interval',{version:d.configVersion,intervalSeconds:60});d=await detail();assert.equal(d.theater.storyId,held);assert.equal(d.theater.operation.paused,true);
   await req(api+'operation',{revision:d.theater.revision-1,command:'start'},409);
   await cmd('select-mode',{mode:'reading-five'});assert.equal((await detail()).theater.readingFiveIds.length,5);
   await cmd('resume');const selected=(await detail()).theater.storyId;await sleep(1100);assert.equal((await detail()).theater.storyId,selected);
   await cmd('next-story');assert.notEqual((await detail()).theater.storyId,selected);
   await cmd('select-mode',{mode:'reading-all'});assert.equal((await detail()).theater.readingAllIds.length,7);
  });
  await t.test('intake/session isolation, manuscript, credit consent and session config',async()=>{
   await cmd('intake-session',{session:2});await req(base+'api/memories',{...submission,requestId:randomUUID()},428);
   await req(base+'api/memories',{...submission,requestId:randomUUID(),session:2,text:'둘째 회차 합성 이야기',nickname:'두번째가상'},201);
   assert(!(await publicState()).memories.some(m=>m.text==='둘째 회차 합성 이야기'));
   await cmd('reading-text',{cue:12,text:'합성 낭독문\n둘째 줄'});await cmd('select-reading',{cue:12});await cmd('select-mode',{mode:'reading-script'});assert.equal((await publicState()).theater.operation.readingText,'합성 낭독문\n둘째 줄');
   await cmd('ending-text',{text:'합성 엔딩\n감사합니다'});await cmd('select-mode',{mode:'ending'});assert.deepEqual((await publicState()).credits.map(c=>c.name),['합성관객']);
   await cmd('session',{session:2});let d=await detail();assert.equal(d.theater.operation.running,false);assert.equal(d.theater.operation.paused,true);assert.equal(d.theater.operation.intervalSeconds,3);assert.equal(d.reading[12],'');assert.equal(d.theater.operation.endingText,'');assert.equal(d.stories.length,1);
   d=await detail();await cmd('random-interval',{version:d.configVersion,intervalSeconds:5});await cmd('session',{session:1});assert.equal((await detail()).theater.operation.intervalSeconds,60);assert.equal((await detail()).reading[12],'합성 낭독문\n둘째 줄');
  });
  await t.test('authenticated CSV, explicit deletion of synthetic data only, no retry resurrection',async()=>{
   const r=await raw(api+'export');assert.equal(r.status,200);const csv=await r.text();assert(csv.includes('비공개 합성 응답'));assert(csv.includes('둘째 회차 합성 이야기'));
   const m=(await req(api+'state')).memories.find(m=>m.id===story.id);
   await req(api+'moderate',{id:m.id,version:m.version,status:'delete'},422);
   await req(api+'moderate',{id:m.id,version:m.version,status:'delete',confirmDelete:true});
   await req(base+'api/memories',submission,410);assert(!(await publicState()).memories.some(m=>m.id===story.id));
  });
  await t.test('emergency stop, logout revocation, restart safety and persistent session settings',async()=>{
   await cmd('start');await cmd('emergency-stop');assert.equal((await publicState()).theater.operation.running,false);
   await cmd('resume');await req(api+'logout',{});assert.equal((await publicState()).theater.operation.running,false);await req(api+'state',undefined,401);
   const login=await raw(api+'login',{username:credentials.username,password:credentials.password});assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];await cmd('start');
   await stop();await start();assert.equal((await publicState()).theater.operation.running,false);assert.equal((await publicState()).theater.operation.intervalSeconds,60);await req(api+'state',undefined,401);
  });
  assert(!serverLog.includes('request failure'), 'No unexpected server errors');
 }finally{await stop();rmSync(temp,{recursive:true,force:true});}
});
