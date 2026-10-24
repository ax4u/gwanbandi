(() => {
 'use strict';
 const $=id=>document.getElementById(id),base='/jungang-memory/manage/api/';
 let snapshot=null,active=false,writing=false,refreshing=false,uncertain=false,generation=0,timer=null;
 let storySignature='',assignmentSignature='',orderSignature='',orderDraft=null,endingDraft=false,storyDraft=false,scriptDrafts={};
 const text=(id,value)=>{$(id).textContent=String(value);};
 // ponytail: one audible tab per origin/browser storage partition, not across PCs.
 const audio=$('reading-five-bgm-audio');audio.volume=Number($('bgm-volume').value);
 let bgmState=null,bgmUntil=0,prepareUntil=0,prepared=false,preparing=false,lockPending=false,releaseAudio=null,audioGeneration=0,audioStarting=false,readSequence=0;
 const bgmAvailable=audio.hasAttribute('src');
 $('bgm-enable').disabled=$('bgm-volume').disabled=!bgmAvailable;
 const bgmMessage=v=>text('bgm-status',bgmAvailable?v:'기본 음원 없음 · 권리가 확인된 MP3를 BGM_FILE로 설정하세요.');
 const wantsBgm=()=>active&&prepared&&performance.now()<bgmUntil&&['reading-five','reading-all','random'].includes(bgmState?.storyMode)&&bgmState.running&&!bgmState.paused;
 function stopBgm(){audioGeneration++;audioStarting=false;audio.pause();if(releaseAudio){const release=releaseAudio;releaseAudio=null;release();}}
 function revokeBgm(reset=false){bgmState=null;bgmUntil=0;preparing=false;stopBgm();if(reset)prepared=false;bgmMessage(reset?'로그인 후 관리자 소리를 다시 준비하세요.':'BGM 정지 · 관리자 상태 확인 대기');}
 async function playBgm(preparation=false){
  if(audioStarting||!releaseAudio)return;
  const g=audioGeneration;audioStarting=true;
  try {
   await audio.play();
   if(g!==audioGeneration)return;
   audioStarting=false;
   if(preparation){prepared=true;preparing=false;}
   if(!wantsBgm()){stopBgm();bgmMessage('소리 준비 완료 · 무작위 또는 상위 5개·전체 낭독 시작 시 자동 재생');}
   else bgmMessage('BGM 재생 중 · 이 관리자 탭의 스피커 출력');
  }catch(e){
   if(g!==audioGeneration)return;
   preparing=false;prepared=false;stopBgm();bgmMessage('BGM 재생 실패 · 관리자 소리 준비를 다시 눌러 주세요. ('+e.name+')');
  }
 }
 function acquireBgm(preparation=false){
  if(lockPending||releaseAudio)return;
  if(!navigator.locks){prepared=preparing=false;bgmMessage('BGM 정지 · 중복 재생 방지 기능을 지원하는 브라우저가 필요합니다.');return;}
  const g=audioGeneration;lockPending=true;
  navigator.locks.request('jungang-reading-five-bgm',{ifAvailable:true},async lock=>{
   lockPending=false;
   if(g!==audioGeneration||!active)return;
   if(!lock){preparing=false;bgmMessage('다른 관리자 탭에서 소리를 사용 중입니다.');return;}
   if(!preparation&&!wantsBgm())return;
   await new Promise(resolve=>{releaseAudio=resolve;playBgm(preparation);});
  }).catch(()=>{lockPending=false;preparing=false;prepared=false;stopBgm();bgmMessage('BGM 잠금 확인 실패 · 소리를 다시 준비하세요.');});
 }
 function syncBgm(){
  if(preparing){if(performance.now()>=prepareUntil)revokeBgm();return;}
  if(!wantsBgm()){if(releaseAudio||audioStarting||!audio.paused)stopBgm();return;}
  if(!releaseAudio)acquireBgm();else if(audio.paused&&!audioStarting)playBgm();
 }
 function acceptBgm(d,started){
  if(performance.now()-started>=5000){revokeBgm();return;}
  bgmState=d.theater.operation;bgmUntil=started+5000;syncBgm();
 }
 $('bgm-enable').onclick=()=>{if(!bgmAvailable||!active||uncertain||writing||!snapshot)return;stopBgm();preparing=true;prepareUntil=performance.now()+5000;acquireBgm(true);};
 $('bgm-volume').oninput=()=>{audio.volume=Number($('bgm-volume').value);};
 setInterval(syncBgm,250);
 function tab(name){for(const b of document.querySelectorAll('[data-console-tab]'))b.setAttribute('aria-selected',String(b.dataset.consoleTab===name));for(const k of ['run','review','advanced-settings'])$('console-'+k).hidden=k!==(name==='advanced'?'advanced-settings':name);}
 document.querySelectorAll('[data-console-tab]').forEach(b=>b.onclick=()=>tab(b.dataset.consoleTab));
 async function api(path,payload){const c=new AbortController(),timer=setTimeout(()=>c.abort(),10000);try{const r=await fetch(base+path,{method:payload===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',signal:c.signal,headers:{Accept:'application/json','X-Jungang-Client':'1',...(payload===undefined?{}:{'Content-Type':'application/json'})},...(payload===undefined?{}:{body:JSON.stringify(payload)})});if(!r.ok){const e=Error('HTTP '+r.status);e.status=r.status;throw e;}return await r.json();}finally{clearTimeout(timer);}}
 function validate(d){if(!d?.theater?.operation||!Number.isSafeInteger(d.theater.revision)||!Number.isSafeInteger(d.configVersion)||!Number.isInteger(d.theater.operation.intervalSeconds)||d.theater.operation.intervalSeconds<1||d.theater.operation.intervalSeconds>60||!Array.isArray(d.modes)||!Array.isArray(d.stories)||!Array.isArray(d.topFive)||!Array.isArray(d.allReading)||!Array.isArray(d.assignments)||![12,13,14].every(cue=>typeof d.reading?.[cue]==='string'))throw Error('운영 상태 형식 오류');return d;}
 const message=v=>text('console-message',v);
 function clear(){revokeBgm(true);active=false;snapshot=null;uncertain=false;writing=false;generation++;clearTimeout(timer);orderDraft=null;endingDraft=storyDraft=false;scriptDrafts={};$('console-script-cue').value=$('console-script-text').value='';text('console-script-current','선택 없음');storySignature=assignmentSignature=orderSignature='';$('console-story').replaceChildren();$('console-reading-order').replaceChildren();$('console-assignments').replaceChildren();$('console-ending-text').value='';text('console-ending-preview','');text('console-current','—');text('console-connection','로그인 필요');controls();}
 function controls(){
  const disabled=!active||!snapshot||writing||refreshing||uncertain;
  document.querySelectorAll('[data-operation],[data-mode],#console-run select,#console-run textarea,#console-run input,#console-run #console-interval-save,#console-reading-order button,#console-reading-save,#console-ending-save,#console-ending-preview-button,#console-story-select,#console-script-save,#console-script-select,#console-script-clear,#console-scroll-save,#console-scroll-toggle,#console-assignments select,#console-assignments button').forEach(e=>e.disabled=disabled);
  $('console-refresh').disabled=!active||writing||refreshing;
  if(!disabled){const op=snapshot.theater.operation;document.querySelector('[data-operation=pause]').disabled=op.paused;document.querySelector('[data-operation=resume]').disabled=!op.paused;document.querySelector('[data-operation=start]').disabled=op.running;
   const manual=['reading-five','reading-all'].includes(op.storyMode);$('console-story-select').disabled=!manual||!$('console-story').value;document.querySelectorAll('[data-operation$="-story"]').forEach(b=>b.disabled=!manual);
   const cue=$('console-script-cue').value;$('console-script-text').disabled=$('console-script-save').disabled=!cue;$('console-script-select').disabled=!cue||Object.hasOwn(scriptDrafts,cue);$('console-script-clear').disabled=op.selectedReading===null;
   for(const b of $('console-assignments').querySelectorAll('[data-assign]'))b.disabled=![1,2].includes(Number(b.closest('[data-id]').querySelector('select').value));
  }
 }
 function render(d){
  const priorSession=snapshot?.theater.session;snapshot=validate(d);const {theater,modes,allReading}=d,op=theater.operation;
  if(priorSession&&priorSession!==theater.session){orderDraft=null;endingDraft=storyDraft=false;scriptDrafts={};$('console-script-cue').value=$('console-script-text').value='';storySignature=orderSignature='';text('console-ending-preview','');}
  text('console-current',`${modes.find(m=>m.id===op.storyMode)?.label||''}${op.storyMode==='random'?` · ${op.intervalSeconds}초`:''}`);text('console-connection',`${theater.session}회차 · 서버 상태: ${op.status}`);
  text('console-interval-current',`${theater.session}회차 현재 저장 간격: ${op.intervalSeconds}초 · 무작위 모드만 적용`);if(document.activeElement!==$('console-interval'))$('console-interval').value=String(op.intervalSeconds);
  for(const b of document.querySelectorAll('[data-mode]'))b.setAttribute('aria-pressed',String(b.dataset.mode===op.storyMode));
  for(const [id,value] of [['console-session',theater.session],['console-intake',d.intakeSession],['console-scroll-speed',op.scrollSpeed]])if(document.activeElement!==$(id))$(id).value=String(value);
  text('console-scroll-toggle',op.scrollPaused?'스크롤 재개':'스크롤 정지');
  if(!endingDraft&&document.activeElement!==$('console-ending-text'))$('console-ending-text').value=op.endingText;
  text('console-script-current',op.selectedReading===null?'선택 없음':`선택된 원고: ${op.selectedReading}`);
  const cue=$('console-script-cue').value;if(!Object.hasOwn(scriptDrafts,cue))$('console-script-text').value=d.reading[cue]??'';
  const source=op.storyMode==='reading-five'?d.topFive:op.storyMode==='reading-all'?allReading:[],signature=JSON.stringify([theater.session,op.storyMode,source]);
  const previous=$('console-story').value;
  if(signature!==storySignature){$('console-story').replaceChildren(new Option(source.length?'사연 선택':'선택 가능한 낭독 사연 없음',''),...source.map(s=>new Option(`${s.nickname||'익명'} · ${s.text.slice(0,65)}`,String(s.id))));storySignature=signature;}
  $('console-story').value=storyDraft?previous:String(theater.storyId??'');
  const ids=allReading.map(s=>s.id),orderKey=JSON.stringify([theater.session,allReading,op.readingOrder]);
  if(orderKey!==orderSignature){
   if(!orderDraft||orderDraft.length!==ids.length||!ids.every(id=>orderDraft.includes(id)))orderDraft=[...ids];
   const list=$('console-reading-order');list.replaceChildren();
   for(const [i,id] of orderDraft.entries()){const s=allReading.find(s=>s.id===id),li=document.createElement('li');li.dataset.id=String(id);const caption=document.createElement('span');caption.textContent=`${i+1}. ${s.nickname||'익명'} · ${s.text.slice(0,65)}${i<5?' · 상위 5개':''}`;li.append(caption);for(const [direction,label] of [['up','위로'],['down','아래로']]){const b=document.createElement('button');b.type='button';b.dataset.move=direction;b.textContent=label;li.append(b);}list.append(li);}orderSignature=orderKey;
  }
  const assignments=d.assignments.filter(a=>a.session===null),assignKey=JSON.stringify(assignments);
  if(assignKey!==assignmentSignature){$('console-assignments').replaceChildren();for(const a of assignments){const row=document.createElement('div');row.dataset.id=String(a.id);row.dataset.version=String(a.version);const label=document.createElement('label');label.textContent=`#${a.id} ${a.nickname||'익명'} · ${a.status} · 배정 회차 `;const select=document.createElement('select');select.append(new Option('회차 선택',''),new Option('1회차','1'),new Option('2회차','2'));label.append(select);const b=document.createElement('button');b.type='button';b.dataset.assign=String(a.id);b.textContent='배정 저장';row.append(label,b);$('console-assignments').append(row);}if(!assignments.length)text('console-assignments','미분류 사연이 없습니다.');assignmentSignature=assignKey;}
  controls();
 }
 function schedule(){clearTimeout(timer);if(active)timer=setTimeout(()=>read(),1500);}
 async function read(explicit=false){if(!active||writing||refreshing)return;const g=generation,seq=++readSequence,started=performance.now();if(explicit){refreshing=true;controls();}try{const d=validate(await api('operation'));if(g!==generation||seq!==readSequence||!active||writing)return;if(d.theater.revision<(snapshot?.theater.revision??0))throw Error('이전 상태');if(explicit){uncertain=false;orderDraft=null;orderSignature='';storyDraft=false;}if(!uncertain){render(d);acceptBgm(d,started);}}catch(e){if(g!==generation||seq!==readSequence)return;revokeBgm();if(e.status===401){clear();return;}uncertain=true;message('연결/상태 확인 실패 · 직접 다시 확인하세요. 명령은 자동 재시도하지 않습니다.');controls();}finally{if(explicit){refreshing=false;controls();}schedule();}}
 async function command(command,extra={}){
  if(!active||!snapshot||writing||refreshing||uncertain)return;
  const revision=snapshot.theater.revision,g=++generation;writing=true;clearTimeout(timer);controls();
  if(['session','pause','emergency-stop'].includes(command)||(command==='select-mode'&&!(wantsBgm()&&['reading-five','reading-all','random'].includes(extra.mode))))revokeBgm();
  try{
   let response;
   if(command==='ending-text'||command==='reading-text'){const chunks=Array.from(extra.text),uploadId=crypto.randomUUID();let offset=0,rev=revision;do{const part=chunks.splice(0,600).join('');response=await api('operation',{revision:rev,command,...extra,text:part,uploadId,offset,final:chunks.length===0});if(response?.ok!==true)throw Error('저장 확인 실패');rev=response.theater.revision;offset+=part.length;}while(chunks.length);}
   else response=await api('operation',{revision,command,...extra});
   if(response?.ok!==true)throw Error('명령 확인 실패');const started=performance.now(),after=validate(await api('operation'));if(g!==generation||!active)return;
   // Wall-clock samples and a playing random story may advance between POST/GET.
   // Revision and every command-controlled field must still match exactly.
   const stable=t=>({...t,storyId:t.operation.storyMode==='random'&&t.operation.running&&!t.operation.paused?undefined:t.storyId,operation:{...t.operation,elapsedMs:undefined,scrollOffset:undefined,timelineAt:undefined,ownerConnected:undefined,status:undefined}});
   if(JSON.stringify(stable(after.theater))!==JSON.stringify(stable(response.theater))||after.theater.revision<=revision)throw Error('서버 상태 변경');
   if(command==='random-interval'&&(after.configVersion<=extra.version||after.theater.operation.intervalSeconds!==extra.intervalSeconds))throw Error('간격 저장 확인 실패');
   if(command==='ending-text'&&after.theater.operation.endingText!==extra.text)throw Error('원문 확인 실패');
   if(command==='reading-text'&&after.reading[extra.cue]!==extra.text)throw Error('원고 확인 실패');
   if(command==='select-reading'&&after.theater.operation.selectedReading!==extra.cue)throw Error('원고 선택 확인 실패');
   if(command==='assign-session'&&after.assignments.find(a=>a.id===extra.id)?.session!==extra.session)throw Error('배정 확인 실패');
   if(command==='intake-session'&&after.intakeSession!==extra.session)throw Error('접수 회차 확인 실패');
   if(command==='ending-text')endingDraft=false;if(command==='reading-text')delete scriptDrafts[extra.cue];if(command==='reading-order'){orderDraft=null;orderSignature='';}storyDraft=false;render(after);acceptBgm(after,started);message('명령 결과와 서버의 현재 상태를 다시 확인했습니다.');
  }catch(e){if(g!==generation)return;revokeBgm();if(e.status===401){clear();return;}uncertain=true;message(e.status===409?'다른 운영자가 변경했습니다. 직접 다시 확인하세요. 자동 재시도하지 않습니다.':'명령 결과 불확실 · 직접 다시 확인 후 결정하세요. 자동 재시도하지 않습니다.');}
  finally{if(g===generation){writing=false;controls();schedule();}}
 }
 window.addEventListener('jungang-presenter',e=>{if(e.detail===true&&!active&&!$('dashboard').hidden){active=true;read(true);}});
 const channel=typeof BroadcastChannel==='function'?new BroadcastChannel('jungang-presenter-session'):null;
 if(channel)channel.onmessage=e=>{if(e.data==='ended')clear();};
 window.addEventListener('jungang-session-ended',()=>{clear();channel?.postMessage('ended');});
 window.addEventListener('pagehide',clear);window.addEventListener('offline',()=>{revokeBgm();uncertain=true;message('오프라인 · 직접 상태 재확인 필요');controls();});
 $('console-refresh').onclick=()=>read(true);
 document.querySelectorAll('[data-operation]').forEach(b=>b.onclick=()=>command(b.dataset.operation));
 document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>command('select-mode',{mode:b.dataset.mode}));
 $('console-interval-save').onclick=()=>{if(!active||!snapshot||writing||refreshing||uncertain)return;const raw=$('console-interval').value;if(!/^[1-9][0-9]*$/.test(raw)||!Number.isInteger(Number(raw))||Number(raw)>60||!$('console-interval').checkValidity()){message('사연 표시 간격은 1~60초 정수로 입력하세요.');return;}command('random-interval',{version:snapshot.configVersion,intervalSeconds:Number(raw)});};
 $('console-session').onchange=()=>command('session',{session:Number($('console-session').value)});
 $('console-intake').onchange=()=>command('intake-session',{session:Number($('console-intake').value)});
 $('console-story').onchange=()=>{storyDraft=true;controls();};$('console-story-select').onclick=()=>command('select-story',{id:Number($('console-story').value)});
 $('console-ending-text').oninput=()=>{endingDraft=true;};
 $('console-ending-preview-button').onclick=()=>{text('console-ending-preview',$('console-ending-text').value);};
 $('console-ending-save').onclick=()=>{const text=$('console-ending-text').value;if([...text].length>5000){message('엔딩 문구는 5000자 이내입니다.');return;}command('ending-text',{text});};
 $('console-script-cue').onchange=()=>{const cue=$('console-script-cue').value;$('console-script-text').value=scriptDrafts[cue]??snapshot?.reading[cue]??'';controls();};
 $('console-script-text').oninput=()=>{scriptDrafts[$('console-script-cue').value]=$('console-script-text').value;controls();};
 $('console-script-save').onclick=()=>{const text=$('console-script-text').value;if([...text].length>5000){message('낭독 원고는 5000자 이내입니다.');return;}command('reading-text',{cue:Number($('console-script-cue').value),text});};
 $('console-script-select').onclick=()=>command('select-reading',{cue:Number($('console-script-cue').value)});
 $('console-script-clear').onclick=()=>command('select-reading',{cue:null});
 $('console-reading-order').onclick=e=>{const b=e.target.closest('[data-move]');if(!b||b.disabled||!orderDraft)return;const i=orderDraft.indexOf(Number(b.closest('li').dataset.id)),j=i+(b.dataset.move==='up'?-1:1);if(j<0||j>=orderDraft.length)return;[orderDraft[i],orderDraft[j]]=[orderDraft[j],orderDraft[i]];orderSignature='';render(snapshot);};
 $('console-reading-save').onclick=()=>command('reading-order',{ids:[...orderDraft]});
 $('console-scroll-save').onclick=()=>command('scroll-setting',{speed:Number($('console-scroll-speed').value),paused:snapshot.theater.operation.scrollPaused});
 $('console-scroll-toggle').onclick=()=>command('scroll-setting',{speed:snapshot.theater.operation.scrollSpeed,paused:!snapshot.theater.operation.scrollPaused});
 $('console-assignments').onchange=controls;$('console-assignments').onclick=e=>{const b=e.target.closest('[data-assign]');if(!b||b.disabled)return;const row=b.closest('[data-id]');command('assign-session',{id:Number(row.dataset.id),version:Number(row.dataset.version),session:Number(row.querySelector('select').value)});};
 controls();
})();
