(() => {
 'use strict';
 if(document.body.dataset.page!=='screen')return;
 // Read-only display: no login, owner token, command, storage or operator UI.
 const $=id=>document.getElementById(id),put=(id,v)=>{if($(id).textContent!==String(v))$(id).textContent=String(v);};
 const HOLD_MS=6000,POLL_MS=1000,TIMEOUT_MS=5000;
 let state=null,deadline=0,wallDeadline=0,epoch=null,seq=-1,revision=-1,contentRevision=-1,configVersion=-1;
 let generation=0,controller=null,timer=null;const retired=new Set();let suspended=false;
 const emit=(name,detail)=>window.dispatchEvent(new CustomEvent(name,{detail}));
 function blank(){
  state=null;deadline=wallDeadline=0;$('story-stage').hidden=true;
  for(const id of ['screen-text','screen-nickname','screen-eyebrow','screen-story-title','screen-position'])put(id,'');
  emit('jungang-expired');
 }
 function valid(){return state&&performance.now()<deadline&&Date.now()<wallDeadline;}
 function expire(){if(state&&!valid())blank();}
 function freeze(){expire();emit('jungang-disconnected');}
 function render(data){
  const t=data.theater,op=t.operation;document.body.dataset.theater=t.mode;
  const mode=op.storyMode,direct=['reading-five','reading-all'].includes(mode);
  const ids=mode==='reading-five'?t.readingFiveIds.slice(0,5):mode==='reading-all'?t.readingAllIds:[];
  const memory=op.running&&t.mode==='story'?data.memories.find(m=>m.id===t.storyId&&(!direct||ids.includes(m.id))):null;
  $('story-stage').hidden=!op.running||t.mode!=='story';$('story-stage').dataset.storyMode=mode;
  $('projector').dataset.font=['small','normal','large'].includes(data.config?.fontSize)?data.config.fontSize:'normal';
  $('screen-eyebrow').hidden=!memory||!direct;$('screen-story-title').hidden=!memory||!direct||!memory.title?.trim();
  put('screen-eyebrow',memory&&direct?`관객이 보내 온 장면  ${ids.indexOf(memory.id)+1} / ${ids.length}`:'');
  put('screen-story-title',$('screen-story-title').hidden?'':memory.title);
  put('screen-text',memory?.text??'');put('screen-nickname',memory?(memory.nickname||'익명의 관객'):'');
  $('screen-nickname').hidden=!memory;
  $('screen-text').dataset.length=Array.from(memory?.text??'').length>75?'long':Array.from(memory?.text??'').length>38?'medium':'short';
  emit('jungang-state',data);
 }
 function accept(data,started,wallStarted,g){
  if(g!==generation||suspended)return;
  const at=Date.parse(data.serverTime),until=Date.parse(data.displayValidUntil),t=data.theater,op=t?.operation;
  if(typeof data.instanceId!=='string'||!Number.isSafeInteger(data.snapshotSeq)||!Number.isSafeInteger(t?.revision)||!Number.isSafeInteger(data.revision)||!op||!Number.isFinite(at)||!Number.isFinite(until)||!Array.isArray(data.memories)||!Array.isArray(data.credits)||!Array.isArray(t.readingFiveIds)||!Array.isArray(t.readingAllIds)||!Number.isFinite(op.scrollOffset))throw Error('invalid state');
  if(retired.has(data.instanceId))return;
  if(epoch===data.instanceId&&(data.snapshotSeq<=seq||t.revision<revision||data.revision<contentRevision||(data.configVersion??0)<configVersion))return;
  // Count the entire request round trip against permission, never renew stale data.
  const budget=Math.min(HOLD_MS,Number(data.displayHoldMs)||0,until-at);
  if(budget<=0||performance.now()>=started+budget||Date.now()>=wallStarted+budget)return;
  if(epoch!==null&&epoch!==data.instanceId){retired.add(epoch);blank();}
  epoch=data.instanceId;seq=data.snapshotSeq;revision=t.revision;contentRevision=data.revision;configVersion=data.configVersion??0;
  state=data;deadline=started+budget;wallDeadline=wallStarted+budget;
  render(data);
 }
 async function poll(){
  if(controller||suspended)return;clearTimeout(timer);expire();
  const c=new AbortController();controller=c;const g=generation,started=performance.now(),wallStarted=Date.now();
  const timeout=setTimeout(()=>c.abort(),TIMEOUT_MS);
  try{
   const response=await fetch('/jungang-memory/api/state',{credentials:'omit',cache:'no-store',signal:c.signal,headers:{Accept:'application/json'}});
   if(!response.ok)throw Error('state unavailable');
   accept(await response.json(),started,wallStarted,g);
  }catch{if(g===generation)freeze();}
  finally{clearTimeout(timeout);if(controller===c)controller=null;expire();if(!suspended&&g===generation)timer=setTimeout(poll,POLL_MS);}
 }
 function interrupt(){generation++;controller?.abort();controller=null;clearTimeout(timer);freeze();}
 window.addEventListener('offline',()=>{interrupt();timer=setTimeout(poll,POLL_MS);});
 window.addEventListener('online',()=>{interrupt();poll();});
 window.addEventListener('pagehide',()=>{suspended=true;interrupt();blank();});
 window.addEventListener('pageshow',()=>{suspended=false;poll();});
 document.addEventListener('visibilitychange',()=>{if(!document.hidden){interrupt();expire();poll();}});
 // Timers may sleep with the OS; visibility/resume checks also use a wall deadline.
 setInterval(expire,100);
 poll();
})();
