import {randomBytes, createHash} from 'node:crypto';
import {transaction} from './client-store.mjs';
import {PUBLIC_MEMORY_WHERE, LEGACY_PUBLIC_MS} from './retention-policy.mjs';
import {freshOperation, switchSession} from './session-split.mjs';
const uuid=()=>randomBytes(16).toString('hex');
const modes=[{id:'random',label:'현장 사연 · 무작위'},{id:'reading-five',label:'직접 낭독 · 상위 5개'},{id:'reading-all',label:'직접 낭독 · 전체'},{id:'reading-script',label:'관리자 낭독 원고'},{id:'ending',label:'엔딩'}];
// Keep legacy cue/BGM values inert; reading slots require an explicit selection.
export function createEventOperation({db,fail,now=Date.now}) {
 let permit=null;const drafts=new Map(),stmt=q=>db.prepare(q),raw=()=>stmt('SELECT * FROM theater_state WHERE id=1').get();
 // An authenticated command grants a process-local permit, not a display lease.
 function atomic(fn){const priorPermit=permit,priorDrafts=new Map(drafts);try{return transaction(db,fn);}catch(e){permit=priorPermit;drafts.clear();for(const [k,v] of priorDrafts)drafts.set(k,v);throw e;}}
 const defaults={storyMode:'random',endingText:'',...freshOperation(),runId:'legacy'};
 const configRow=()=>stmt('SELECT version,config FROM event_config WHERE event_id=?').get('jungang-memory');
 const interval=()=>JSON.parse(configRow().config).intervalSeconds;
 const opOf=row=>{const op={...defaults,randomPaused:!!stmt('SELECT paused FROM settings WHERE id=1').get().paused,...JSON.parse(row.cue_bgm)._operation};return {...op,reading:{...op.reading},randomSeed:op.randomSeed??op.runId};};
 // Only commands persist anchors. Reads sample the same timeline on every screen;
 // a legacy operation without an anchor stays at zero until an explicit command.
 function sample(op,at){
  const delta=Number.isFinite(op.timelineAt)?Math.max(0,at-op.timelineAt):0,playing=op.running&&!op.paused;
  return {...op,elapsedMs:op.elapsedMs+(playing&&!(op.storyMode==='random'&&op.randomPaused)?delta:0),scrollOffset:op.scrollOffset+(playing&&!op.scrollPaused&&['reading-script','ending'].includes(op.storyMode)?delta*op.scrollSpeed/1000:0),timelineAt:at};
 }
 function restart(op){op.elapsedMs=0;op.randomOffset=0;op.scrollOffset=0;op.randomSeed=uuid();}
 function invalidate(op){op.runId=uuid();op.pending=null;}
 function save(row,op,{storyId=row.story_id,creditsRun=row.credits_run}={}){
  const bgm=JSON.parse(row.cue_bgm);bgm._operation=op;
  if(stmt('UPDATE theater_state SET story_id=?,credits_run=?,cue_bgm=?,revision=revision+1 WHERE id=1 AND revision=?').run(storyId,creditsRun,JSON.stringify(bgm),row.revision).changes!==1)fail(409,'진행 상태가 바뀌었습니다. 다시 확인하세요.');
 }

 function permitted(){if(permit&&permit.until>now()){try{permit.authorize();return true;}catch{}}return false;}
 function permitUntil(){return permitted()?permit.until:now();}
 function grant(authorize){const until=authorize();if(!Number.isFinite(until)||until<=now())fail(401,'로그인이 필요합니다.');permit={authorize,until};}
 // Keep the existing restart safety boundary; never persist a session capability.
 transaction(db,()=>{const r=raw(),op={...JSON.parse(r.cue_bgm)._operation};op.running=false;op.paused=true;invalidate(op);save(r,op);});
 function revoke(){
  if(!permit||permitted())return;
  atomic(()=>{const r=raw(),op=sample(opOf(r),Math.min(now(),permit.until));op.running=false;op.paused=true;invalidate(op);save(r,op);permit=null;});
 }
 const permitTimer=setInterval(()=>{try{revoke();}catch{console.error('presentation permit check failed');}},250);permitTimer.unref();
 function stories(){
  const paused=stmt('SELECT paused FROM settings WHERE id=1').get().paused;
  return stmt(`SELECT id,COALESCE(display_text,text) AS text,nickname,read_aloud FROM memories WHERE ${PUBLIC_MEMORY_WHERE} AND session=?${paused?' AND id IN (SELECT id FROM frozen)':''} ORDER BY created_at,id LIMIT 10000`).all(now()-LEGACY_PUBLIC_MS,raw().session).map(r=>({id:r.id,text:r.text,nickname:r.nickname,readAloud:r.read_aloud===1}));
 }
 function allReading(op=opOf(raw())){const all=stories().filter(s=>s.readAloud),rank=new Map(op.readingOrder.map((id,i)=>[id,i]));return all.sort((a,b)=>(rank.get(a.id)??Infinity)-(rank.get(b.id)??Infinity));}
 function topFive(op=opOf(raw())){return allReading(op).slice(0,5);}
 function reading(op){return op.storyMode==='reading-five'?topFive(op):op.storyMode==='reading-all'?allReading(op):[];}
 function selected(op){const list=reading(op),id=op.storyMode==='reading-five'?op.story10:op.storyAll;return list.some(s=>s.id===id)?id:list[0]?.id??null;}
 function randomStory(op){
  const shuffled=stories().map(s=>({id:s.id,key:createHash('sha256').update(`${op.randomSeed}:${s.id}`).digest('hex')})).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:a.id-b.id);
  return shuffled[((op.randomOffset??0)+Math.floor(op.elapsedMs/(interval()*1000)))%shuffled.length]?.id??null;
 }
 function state(at=now()){
  const r=raw(),op=sample(opOf(r),at);if(!permitted()){op.running=false;op.paused=true;}
  const selectedReading=[12,13,14].includes(op.selectedReading)?op.selectedReading:null;
  return {mode:op.storyMode==='ending'?'ending':op.storyMode==='reading-script'?'reading':'story',session:r.session,revision:r.revision,creditsRun:r.credits_run,storyId:op.storyMode==='random'?randomStory(op):selected(op),readingFiveIds:op.storyMode==='reading-five'?topFive(op).map(s=>s.id):[],readingAllIds:op.storyMode==='reading-all'?allReading(op).map(s=>s.id):[],operation:{intervalSeconds:interval(),storyMode:op.storyMode,endingText:op.endingText,selectedReading,readingText:op.storyMode==='reading-script'&&selectedReading!==null?op.reading[selectedReading]??'':'',readingOrder:op.readingOrder,running:op.running,paused:op.paused,runId:op.runId,elapsedMs:op.elapsedMs,scrollOffset:op.scrollOffset,timelineAt:op.timelineAt,scrollSpeed:op.scrollSpeed,scrollPaused:op.scrollPaused,ownerConnected:false,status:!op.running?'상영 정지':op.paused?'일시정지 · 진행 위치 보존':'상영 중 · 서버 진행'}};
 }
 // Anonymous display contract: never spread the administrator's state. Candidate
 // lists/order and even a reading-only mode paired with storyId reveal volunteers.
 function publicState(at=now()){
  const t=state(at),op=t.operation;
  const storyMode=op.running&&['reading-script','ending'].includes(op.storyMode)?op.storyMode:'story';
  return {
   mode:storyMode==='ending'?'ending':storyMode==='reading-script'?'reading':'story',
   session:t.session,revision:t.revision,creditsRun:t.creditsRun,
   storyId:op.running&&storyMode==='story'?t.storyId:null,
   operation:{storyMode,running:op.running,paused:op.paused,runId:op.runId,
    intervalSeconds:op.intervalSeconds,scrollOffset:op.scrollOffset,scrollSpeed:op.scrollSpeed,scrollPaused:op.scrollPaused,
    selectedReading:storyMode==='reading-script'?op.selectedReading:null,
    readingText:storyMode==='reading-script'?op.readingText:'',
    endingText:storyMode==='ending'?op.endingText:''},
  };
 }
 function detail(){return {theater:state(),configVersion:configRow().version,modes,reading:opOf(raw()).reading,stories:stories(),topFive:topFive(),allReading:allReading(),assignments:stmt('SELECT id,nickname,session,version,status FROM memories ORDER BY id').all(),intakeSession:stmt('SELECT intake_session FROM session_control WHERE id=1').get().intake_session};}
 function cas(b){const r=raw();if(!Number.isSafeInteger(b.revision)||b.revision!==r.revision)fail(409,'진행 상태가 바뀌었습니다. 자동 재시도하지 않습니다.');return r;}
 function execute(b,authorize){return atomic(()=>{
  authorize();const row=cas(b),at=now(),op=sample(opOf(row),at),cmd=b.command;
  if(cmd==='start'){grant(authorize);op.running=true;op.paused=false;restart(op);invalidate(op);save(row,op);}
  else if(cmd==='random-interval'){
   if(!Number.isInteger(b.intervalSeconds)||b.intervalSeconds<1||b.intervalSeconds>60)fail(422,'사연 전환 간격은 1~60초 정수로 입력하세요.');
   const current=configRow();if(!Number.isSafeInteger(b.version)||b.version!==current.version)fail(409,'행사 설정이 변경됐습니다. 다시 확인하세요.');
   const previous=JSON.parse(current.config),oldInterval=previous.intervalSeconds;
   resetIntervalPhase(op,oldInterval);
   stmt('INSERT INTO config_history(event_id,config,created_at,session) VALUES(?,?,?,?)').run('jungang-memory',current.config,at,row.session);
   stmt('UPDATE event_config SET version=version+1,config=? WHERE event_id=? AND version=?').run(JSON.stringify({...previous,intervalSeconds:b.intervalSeconds}),'jungang-memory',current.version);
   stmt(`DELETE FROM config_history WHERE event_id=? AND session=? AND id NOT IN (SELECT id FROM config_history WHERE event_id=? AND session=? ORDER BY id DESC LIMIT 20)`).run('jungang-memory',row.session,'jungang-memory',row.session);
   stmt('UPDATE settings SET revision=revision+1 WHERE id=1').run();save(row,op);
  }else if(cmd==='select-mode'){
   if(!modes.some(m=>m.id===b.mode))fail(422,'사연 상영 모드를 선택하세요.');op.storyMode=b.mode;restart(op);invalidate(op);save(row,op,{storyId:selected(op),creditsRun:row.credits_run+(b.mode==='ending'?1:0)});
  }else if(cmd==='session'){
   if(![1,2].includes(b.session))fail(422,'회차1 또는2를 선택하세요.');invalidate(op);op.paused=true;save(row,op);switchSession(db,b.session,at);permit=null;
  }else if(cmd==='intake-session'){
   if(![1,2].includes(b.session))fail(422,'접수 회차를 선택하세요.');stmt('UPDATE session_control SET intake_session=? WHERE id=1').run(b.session);invalidate(op);save(row,op);
  }else if(cmd==='assign-session'){
   if(![null,1,2].includes(b.session)||!Number.isSafeInteger(b.id)||!Number.isSafeInteger(b.version))fail(422,'사연 회차를 확인하세요.');
   const changed=stmt('UPDATE memories SET session=?,version=version+1 WHERE id=? AND version=?').run(b.session,b.id,b.version);if(changed.changes!==1)fail(409,'사연이 변경되었습니다.');
   stmt('UPDATE settings SET revision=revision+1 WHERE id=1').run();invalidate(op);save(row,op);
  }else if(['select-story','next-story','previous-story'].includes(cmd)){
   if(!['reading-five','reading-all'].includes(op.storyMode))fail(422,'낭독 모드에서 사연을 선택하세요.');
   const list=reading(op),index=list.findIndex(s=>s.id===selected(op));
   const id=cmd==='select-story'?b.id:list[(Math.max(index,0)+(cmd==='next-story'?1:-1)+list.length)%list.length]?.id??null;
   if(cmd==='select-story'&&!list.some(s=>s.id===id))fail(422,'현재 회차의 상영 가능한 낭독 사연을 선택하세요.');
   op[op.storyMode==='reading-five'?'story10':'storyAll']=id;restart(op);invalidate(op);save(row,op,{storyId:id});
  }else if(cmd==='reading-order'){
   const ids=new Set(stories().filter(s=>s.readAloud).map(s=>s.id));if(!Array.isArray(b.ids)||b.ids.length>10000||new Set(b.ids).size!==b.ids.length||b.ids.some(id=>!ids.has(id)))fail(422,'해당 회차 낭독 동의자 순서를 확인하세요.');op.readingOrder=b.ids;invalidate(op);save(row,op);
  }else if(cmd==='select-reading'){
   if(![null,12,13,14].includes(b.cue))fail(422,'낭독 원고 또는 선택 해제를 지정하세요.');op.selectedReading=b.cue;restart(op);invalidate(op);save(row,op);
  }else if(cmd==='ending-text'||cmd==='reading-text'){
   if(cmd==='reading-text'&&![12,13,14].includes(b.cue))fail(422,'낭독 원고를 선택하세요.');
   if(typeof b.text!=='string'||[...b.text].length>5000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(b.text))fail(422,'문구/원고는5000자 이내입니다.');
   let text=b.text;const key=`${row.session}:${cmd}:${cmd==='reading-text'?b.cue:''}`;
   if(b.uploadId!==undefined){
    if(typeof b.uploadId!=='string'||!/^[a-f0-9-]{36}$/.test(b.uploadId)||!Number.isSafeInteger(b.offset)||b.offset<0||typeof b.final!=='boolean'||[...b.text].length>800)fail(422,'분할 저장 형식을 확인하세요.');
    const previous=drafts.get(key);
    if(b.offset>0&&(!previous||previous.id!==b.uploadId||previous.text.length!==b.offset||previous.revision!==row.revision||now()-previous.at>300000))fail(409,'저장이 중단되거나 상태가 변경됐습니다. 원문은 유지됩니다.');
    text=(b.offset===0?'':previous.text)+b.text;if([...text].length>5000)fail(422,'문구/원고5000자 초과');
    if(!b.final){drafts.set(key,{id:b.uploadId,text,at:now(),revision:row.revision+1});invalidate(op);save(row,op);return {ok:true,theater:state()};}
   }
   if(cmd==='reading-text')op.reading[b.cue]=text;else op.endingText=text;
   if(cmd==='reading-text'&&op.storyMode==='reading-script'&&op.selectedReading===b.cue||cmd==='ending-text'&&op.storyMode==='ending')restart(op);
   invalidate(op);save(row,op);drafts.delete(key);
  }else if(cmd==='scroll-setting'){
   if(!Number.isFinite(b.speed)||b.speed<8||b.speed>60||typeof b.paused!=='boolean')fail(422,'스크롤속도8~60과 정지를 확인하세요.');op.scrollSpeed=b.speed;op.scrollPaused=b.paused;invalidate(op);save(row,op);
  }else if(cmd==='restart-credits'){restart(op);invalidate(op);save(row,op,{creditsRun:row.credits_run+1});}
  else if(['pause','resume','emergency-stop'].includes(cmd)){
   op.paused=cmd!=='resume';if(cmd==='resume'){grant(authorize);op.running=true;}if(cmd==='emergency-stop'){op.running=false;permit=null;}invalidate(op);save(row,op);
  }else fail(422,'운영 명령을 확인하세요.');
  return {ok:true,theater:state()};
 });}
 // Called only inside the authenticated settings writer's existing transaction.
 // List freeze pauses random progression, independently of manuscript scrolling.
 function settingsChanged(paused){const row=raw(),op=sample(opOf(row),now());op.randomPaused=paused;save(row,op);}
 function resetIntervalPhase(op,oldInterval){if(op.storyMode==='random'){op.randomOffset=(op.randomOffset??0)+Math.floor(op.elapsedMs/(oldInterval*1000));op.elapsedMs=0;}}
 // A config publish/restore may also change the same interval; keep its phase stable.
 function intervalChanged(oldInterval){const row=raw(),op=sample(opOf(row),now());resetIntervalPhase(op,oldInterval);save(row,op);}
 // Retired clients must not claim or mutate the new server timeline.
 function playback(b,session,authorize){authorize();fail(410,'구형 상영 제어는 종료됐습니다. 관리자에서 제어하세요.');}
 return {state,publicState,detail,execute,playback,stories,topFive,allReading,permitUntil,settingsChanged,intervalChanged};
}
