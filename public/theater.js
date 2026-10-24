(() => {
 'use strict';
 if(document.body.dataset.page!=='screen')return;
 const $=id=>document.getElementById(id);
 let data=null,stateAt=0,disconnected=false,creditSignature='',animation=null,fitFrame;
 function fitStory(){
  if($('story-stage').hidden)return;
  const text=$('screen-text'),box=text.parentElement,scale=$('theater-canvas').clientWidth/100;
  const multiplier={small:.9,normal:1,large:1.1}[$('projector').dataset.font]||1;
  const direct=['reading-five','reading-all'].includes($('story-stage').dataset.storyMode);
  let size=direct ? 3.75*scale : ({short:5.6875,medium:4.9,long:3.8659090909}[text.dataset.length]||5.6875)*scale*multiplier;
  const css=getComputedStyle(box),room=box.clientHeight-parseFloat(css.paddingTop)-parseFloat(css.paddingBottom);
  const used=()=>{const children=[...box.children].filter(c=>!c.hidden);return children.reduce((n,c)=>n+c.getBoundingClientRect().height,0)+Math.max(0,children.length-1)*parseFloat(css.rowGap);};
  const apply=()=>{text.style.fontSize=size+'px';$('screen-nickname').style.fontSize=direct?Math.min(2.35*scale,size*.75)+'px':Math.min(2.2*scale,size*.6)+'px';};apply();
  while(size>.1*scale&&(used()>room+.1||text.scrollWidth>text.clientWidth+1)){size-=.05*scale;apply();}
 }
 function fit(){cancelAnimationFrame(fitFrame);fitFrame=requestAnimationFrame(fitStory);}
 function clear(){animation?.cancel();animation=null;creditSignature='';for(const id of ['credits-roll','reading-roll'])$(id).replaceChildren();$('ending-stage').hidden=$('reading-stage').hidden=true;}
 function render(){
  const theater=data?.theater,op=theater?.operation,ready=!!op?.running;
  const ending=ready&&op.storyMode==='ending',reading=ready&&op.storyMode==='reading-script'&&[12,13,14].includes(op.selectedReading)&&typeof op.readingText==='string'&&op.readingText.trim().length>0;
  $('ending-stage').hidden=!ending;$('reading-stage').hidden=!reading;
  if(!ending&&!reading){clear();return;}
  const names=data.credits.filter(c=>typeof c.name==='string').map(c=>c.name);
  const signature=JSON.stringify(reading?[theater.session,'reading-script',op.selectedReading,op.readingText]:[theater.session,'ending',theater.creditsRun,op.endingText,names]);
  if(signature!==creditSignature){
   creditSignature=signature;animation?.cancel();
   $('credits-roll').replaceChildren();$('reading-roll').replaceChildren();
   const para=text=>{const p=document.createElement('p');p.textContent=text;return p;};
   const roll=$(reading?'reading-roll':'credits-roll'),height=$(reading?'reading-window':'credits-window').clientHeight;
   roll.replaceChildren(...(reading?[para(op.readingText)]:[para(op.endingText||''),...names.map(para)]));
   animation=roll.animate([{transform:`translateY(${height}px)`},{transform:`translateY(-${roll.scrollHeight}px)`}],{duration:(height+roll.scrollHeight)/24*1000,iterations:1,fill:'forwards',easing:'linear'});
  }
  if(animation){
   const moving=!op.paused&&!op.scrollPaused&&!disconnected;
   // Rendering follows the server's cumulative CSS-pixel distance, never resets
   // progression because a display was opened, resized or briefly disconnected.
   const offset=op.scrollOffset+(moving?(performance.now()-stateAt)*op.scrollSpeed/1000:0);
   animation.currentTime=Math.min(animation.effect.getTiming().duration,Math.max(0,offset/24*1000));
   animation.playbackRate=op.scrollSpeed/24;
   if(!moving)animation.pause();else if(animation.playState==='paused')animation.play();
  }
 }
 window.addEventListener('jungang-state',e=>{data=e.detail;stateAt=performance.now();disconnected=false;render();fit();});
 window.addEventListener('jungang-disconnected',()=>{
  if(data&&!disconnected){const op=data.theater.operation;data={...data,theater:{...data.theater,operation:{...op,scrollOffset:animation?Number(animation.currentTime)*24/1000:op.scrollOffset}}};}
  disconnected=true;animation?.pause();
 });
 window.addEventListener('jungang-expired',()=>{data=null;clear();});
 window.addEventListener('pagehide',()=>{data=null;clear();});
 const resize=()=>{creditSignature='';render();fit();};
 new ResizeObserver(resize).observe($('theater-canvas'));
 new MutationObserver(fit).observe($('story-stage'),{childList:true,characterData:true,subtree:true});
 document.fonts.ready.then(()=>{resize();});
})();
