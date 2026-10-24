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
 const privateValues=new Set(['비공개 합성 응답']);
 function noPrivate(value){
  const forbidden=new Set(['readAloud','read_aloud','question2','readingFiveIds','readingAllIds','readingOrder','topFive','allReading','assignments','reading','history','displayText','display_text','requestId','request_id','password','password_hash','contact','email','phone']);
  function walk(v){if(v&&typeof v==='object')for(const [k,x] of Object.entries(v)){assert(!forbidden.has(k),`Anonymous private field: ${k}`);walk(x);}}
  walk(value);const serialized=JSON.stringify(value);for(const secret of privateValues)assert(!serialized.includes(secret),'Anonymous private value leaked');
 }
 const keys=(value,expected)=>assert.deepEqual(Object.keys(value).sort(),expected.split(' ').sort());
 function checkPublic(p){
  noPrivate(p);
  keys(p,'version config revision paused approval theater intakeSession credits serverTime displayHoldMs displayValidUntil instanceId snapshotSeq memories total');
  keys(p.config,'eventName participationGuide inputExample waitingText background fontSize intervalSeconds');
  keys(p.theater,'mode session revision creditsRun storyId operation');
  keys(p.theater.operation,'storyMode running paused runId intervalSeconds scrollOffset scrollSpeed scrollPaused selectedReading readingText endingText');
  for(const m of p.memories)keys(m,'id text nickname scene createdAt');
  for(const c of p.credits)keys(c,'name expiresAt');
  const op=p.theater.operation;assert(['story','reading-script','ending'].includes(op.storyMode));
  if(!op.running){assert.equal(p.theater.storyId,null);assert.equal(op.storyMode,'story');}
  if(op.storyMode!=='reading-script'){assert.equal(op.selectedReading,null);assert.equal(op.readingText,'');}
  if(op.storyMode!=='ending')assert.equal(op.endingText,'');
  if(p.theater.storyId!==null)assert(p.memories.some(m=>m.id===p.theater.storyId));
  return p;
 }
 const publicState=async()=>checkPublic(await req(base+'api/state',undefined,200,{},false));
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
   const anonymous=await req(base+'api/state',undefined,200,{},false);
   assert(!Object.hasOwn(anonymous.theater,'readingAllIds'),'Anonymous state must not expose reading volunteers');
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
  await t.test('anonymous API allowlists, private canaries and authenticated views',async()=>{
   const secret='PRIVATE-CONTACT-fixture@example.invalid',original='PRIVATE-ORIGINAL-CANARY',history='PRIVATE-HISTORY-CANARY';
   for(const value of [secret,original,history])privateValues.add(value);
   // Only the temporary synthetic DB: emulate retained/private legacy fields.
   const db=new DatabaseSync(join(data,'memories.sqlite'));
   let fixture;
   try{
    fixture=Number(db.prepare(`INSERT INTO memories(request_id,text,display_text,nickname,scene,status,created_at,published_at,question2,read_aloud,public_consent,credit_consent,consent_policy,session)
     VALUES(?,?,?,'비공개시험','screen','visible',?,?,?,1,1,0,?,1)`).run(randomUUID(),original,'공개 검수 문장',Date.now(),Date.now(),secret,CONSENT_POLICY).lastInsertRowid);
    db.prepare('INSERT INTO memory_history(memory_id,display_text,created_at) VALUES(?,?,?)').run(fixture,history,Date.now());
    const config=JSON.parse(db.prepare('SELECT config FROM event_config').get().config);
    db.prepare('UPDATE event_config SET config=?').run(JSON.stringify({...config,contact:secret,privateExtension:{email:secret}}));
   }finally{db.close();}
   const privateMemory=(await req(api+'state')).memories.find(m=>m.id===fixture);
   assert.equal(privateMemory.text,original);assert.equal(privateMemory.question2,secret);assert.equal(privateMemory.readAloud,true);assert.equal(privateMemory.history[0].displayText,history);
   assert((await detail()).allReading.some(m=>m.id===fixture));
   const p=await publicState();assert.equal(p.memories.find(m=>m.id===fixture).text,'공개 검수 문장');
   for(const path of ['health','config','state']){
    const response=await raw(base+'api/'+path,undefined,{},false);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');const payload=await response.json();noPrivate(payload);
    if(path==='health')keys(payload,'ok app schema experience');
    if(path==='config')keys(payload,'publicUrl pollMs retentionDays legacyPublicDays consentPolicy storage deletionContact maxText maxNickname maxQuestion2');
    if(path==='state')checkPublic(payload);
    const head=await fetch(origin+base+'api/'+path,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
    noPrivate(await req(base+'api/'+path+'?admin=true',undefined,200,{},false));
   }
   const receipt=await req(base+'api/memories',{...submission,requestId:randomUUID(),session:2,readAloud:false,creditConsent:false},201,{},false);
   keys(receipt,'id session status duplicate consentPolicy');noPrivate(receipt);
   noPrivate(await req(base+'api/memories',undefined,404,{},false));
   noPrivate(await req(base+'api/memories',{...submission,text:'fixture@example.invalid'},422,{},false));
   for(const action of ['state','operation','presenter','export']){
    noPrivate(await req(api+action,undefined,401,{},false));
    noPrivate(await req(api+action+'?admin=true',undefined,404,{},false));
   }
   for(const action of ['logout','preview','publish','restore','preview-memory','memory','restore-memory','settings','moderate','operation','playback'])noPrivate(await req(api+action,{},401,{},false));
   // The separate SSH/local listener also requires its own authentication.
   const local=`http://127.0.0.1:${adminPort}`;
   let r=await fetch(local+'/control/api/state');assert.equal(r.status,401);noPrivate(await r.json());
   r=await fetch(local+'/control/api/login',{method:'POST',headers:{Origin:local,'X-Jungang-Admin':'1','Content-Type':'application/json'},body:JSON.stringify({key:readFileSync(join(data,'admin.key'),'utf8').trim()})});
   assert.equal(r.status,200);const localCookie=r.headers.get('set-cookie').split(';')[0];
   r=await fetch(local+'/control/api/state',{headers:{Cookie:localCookie}});assert.equal(r.status,200);assert((await r.json()).memories.some(m=>m.text===original));
   const html=await(await raw(base,undefined,{},false)).text();assert(html.includes('낭독 의사는 담당자만 확인합니다.'));assert(html.includes('질문2·낭독 의사는 담당자만 확인합니다.'));
  });
  await t.test('private roster lifecycle, neutral display and per-session selection',async()=>{
   const db=new DatabaseSync(join(data,'memories.sqlite')),fixtures=[];
   try{
    for(const session of [1,2])for(const kind of ['yes','no','unknown','pending','hidden','refused','expired','legacy','unclassified']){
     const stamp=Date.now()-(kind==='expired'?8*86400000:0),text=`합성 경계 ${session} ${kind}`,nickname=`가상${session}${kind}`;
     const id=Number(db.prepare(`INSERT INTO memories(request_id,text,nickname,scene,status,created_at,published_at,question2,read_aloud,public_consent,credit_consent,consent_policy,session) VALUES(?,?,?,'screen',?,?,?,'비공개 합성 응답',?,?,1,?,?)`).run(randomUUID(),text,nickname,['pending','hidden'].includes(kind)?kind:'visible',stamp,stamp,kind==='no'?0:kind==='unknown'?null:1,kind==='refused'?0:1,['expired','legacy'].includes(kind)?null:CONSENT_POLICY,kind==='unclassified'?null:session).lastInsertRowid);
     fixtures.push({id,session,kind,text,nickname});
    }
   }finally{db.close();}
   const expected=['yes','no','unknown','legacy'];
   for(const session of [1,2]){
    await cmd('session',{session});await cmd('select-mode',{mode:'reading-all'});
    let d=await detail();const ids=d.allReading.map(m=>m.id).reverse();await cmd('reading-order',{ids});
    d=await detail();assert.deepEqual(d.theater.operation.readingOrder,ids);assert.deepEqual(d.allReading.map(m=>m.id),ids);assert.deepEqual(d.topFive.map(m=>m.id),ids.slice(0,5));
    for(const f of fixtures){assert.equal(d.stories.some(m=>m.id===f.id),f.session===session&&expected.includes(f.kind));assert.equal(d.allReading.some(m=>m.id===f.id),f.session===session&&['yes','legacy'].includes(f.kind));}
    for(const mode of ['random','reading-five','reading-all']){
     await cmd('select-mode',{mode});await cmd('emergency-stop');let p=await publicState();assert.equal(p.theater.storyId,null);
     await cmd('start');d=await detail();
     if(mode!=='random'){
      const list=mode==='reading-five'?d.topFive:d.allReading;const target=list.at(-1).id;
      const result=await cmd('select-story',{id:target});assert.equal(result.theater.storyId,target);
      assert.equal((await req(api+'presenter')).theater.storyId,target);
      p=await publicState();assert.equal(p.theater.storyId,target);
      await cmd('next-story');await cmd('previous-story');assert.equal((await detail()).theater.storyId,target);
      const no=fixtures.find(f=>f.session===session&&f.kind==='no');await req(api+'operation',{revision:(await detail()).theater.revision,command:'select-story',id:no.id},422);
     }
     p=await publicState();assert.equal(p.theater.operation.storyMode,'story');
     for(const f of fixtures){assert.equal(p.memories.some(m=>m.id===f.id),f.session===session&&expected.includes(f.kind));assert.equal(p.credits.some(c=>c.name===f.nickname),f.session===session&&expected.includes(f.kind));}
     await cmd('pause');assert.equal((await publicState()).theater.operation.paused,true);
    }
    const f=fixtures.find(f=>f.session===session&&f.kind==='yes');
    await cmd('select-story',{id:f.id});
    for(const status of ['hidden','visible','pending','visible','delete']){
     const m=(await req(api+'state')).memories.find(m=>m.id===f.id);
     await req(api+'moderate',{id:m.id,version:m.version,status,...(status==='delete'?{confirmDelete:true}:{})});
     const p=await publicState();assert.equal(p.memories.some(m=>m.id===f.id),status==='visible');
     assert.equal((await detail()).allReading.some(m=>m.id===f.id),status==='visible');
     if(status!=='visible')assert.notEqual(p.theater.storyId,f.id);
    }
    // A stale private order may still reference a deleted/moved ID; it stays private.
    const legacy=fixtures.find(f=>f.session===session&&f.kind==='legacy'),m=(await req(api+'state')).memories.find(m=>m.id===legacy.id);
    await cmd('assign-session',{id:m.id,version:m.version,session:null});assert(!(await publicState()).memories.some(x=>x.id===m.id));
    await cmd('assign-session',{id:m.id,version:m.version+1,session});
    await cmd('reading-text',{cue:12,text:`현재 상영 원고 ${session}`});await cmd('reading-text',{cue:13,text:`PRIVATE-DRAFT-${session}`});privateValues.add(`PRIVATE-DRAFT-${session}`);
    await cmd('ending-text',{text:`현재 엔딩 ${session}`});await cmd('select-reading',{cue:12});
    for(const mode of ['reading-script','ending']){
     await cmd('select-mode',{mode});await cmd('emergency-stop');let p=await publicState();assert.equal(p.theater.operation.readingText,'');assert.equal(p.theater.operation.endingText,'');
     await cmd('start');p=await publicState();assert.equal(p.theater.operation[mode==='ending'?'endingText':'readingText'],mode==='ending'?`현재 엔딩 ${session}`:`현재 상영 원고 ${session}`);
     await cmd('pause');await publicState();await cmd('resume');await publicState();
    }
    assert.equal((await detail()).reading[13],`PRIVATE-DRAFT-${session}`);
   }
   await cmd('session',{session:1});await publicState();
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
  await t.test('expired administrator cannot expose a queued story or stored scripts',async()=>{
   for(const mode of ['reading-all','reading-script','ending']){
    const db=new DatabaseSync(join(data,'memories.sqlite'));let account;
    try{account=await issueClientAccount(db,{expiresAt:Date.now()+3600000});}finally{db.close();}
    const login=await raw(api+'login',{username:account.username,password:account.password});assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];
    await cmd('select-mode',{mode});await cmd('start');const before=await publicState();
    if(mode==='reading-all')assert.notEqual(before.theater.storyId,null);
    else assert.notEqual(before.theater.operation[mode==='ending'?'endingText':'readingText'],'');
    const expired=new DatabaseSync(join(data,'memories.sqlite'));
    try{expired.prepare('UPDATE client_accounts SET expires_at=? WHERE username=?').run(Date.now()-1,account.username);}finally{expired.close();}
    const p=await publicState();assert.equal(p.theater.operation.running,false);assert.equal(p.theater.storyId,null);assert.equal(p.theater.operation.readingText,'');assert.equal(p.theater.operation.endingText,'');
    for(const action of ['state','operation','presenter','export'])noPrivate(await req(api+action,undefined,401));
   }
  });
  assert(!serverLog.includes('request failure'), 'No unexpected server errors');
 }finally{await stop();rmSync(temp,{recursive:true,force:true});}
});
