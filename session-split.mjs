import {transaction} from './client-store.mjs';
import {randomBytes} from 'node:crypto';
export const freshOperation=()=>({running:false,paused:true,muted:false,runId:randomBytes(16).toString('hex'),elapsedMs:0,scrollOffset:0,timelineAt:null,delay:Object.fromEntries(Array.from({length:16},(_,i)=>[i+1,3])),pending:null,reading:{12:'',13:'',14:''},selectedReading:null,scrollSpeed:24,scrollPaused:false,readingOrder:[],story9:null,story10:null,mediaRevision:0});
// Additive v7. Preserve ALL legacy rows/consents verbatim; NULL is unclassified.
// Archive the old mixed runtime, never infer a session from age or live selection.
export function migrateSessionSchema(db,defaultVersion=null) {
 transaction(db,()=>{
  const v=db.prepare('PRAGMA user_version').get().user_version;if(v===7)return;if(v!==6)throw Error('Expected schema 6');
  const old=db.prepare('SELECT * FROM theater_state WHERE id=1').get();
  const config=db.prepare('SELECT config FROM event_config').get().config;
  const settings=db.prepare('SELECT paused,approval FROM settings WHERE id=1').get();
  db.exec(`ALTER TABLE memories ADD COLUMN session INTEGER DEFAULT NULL CHECK(session IS NULL OR session IN(1,2));
   ALTER TABLE config_history ADD COLUMN session INTEGER DEFAULT NULL CHECK(session IS NULL OR session IN(1,2));
   CREATE TABLE event_sessions(session INTEGER PRIMARY KEY CHECK(session IN(1,2)),snapshot TEXT NOT NULL);
   CREATE TABLE session_control(id INTEGER PRIMARY KEY CHECK(id=1),intake_session INTEGER NOT NULL CHECK(intake_session IN(1,2)),legacy_runtime TEXT NOT NULL);
   CREATE INDEX memory_session ON memories(session,created_at,id);`);
  db.prepare('INSERT INTO session_control VALUES(1,1,?)').run(JSON.stringify({theater:old,config,settings,frozen:db.prepare('SELECT id FROM frozen').all()}));
  const opening=defaultVersion?{mode:'track',version:defaultVersion}:{mode:'silent',version:null};
  for(const session of [1,2])db.prepare('INSERT INTO event_sessions VALUES(?,?)').run(session,JSON.stringify({cue:1,mode:'opening',story_id:null,credits_run:0,cue_bgm:JSON.stringify({...Object.fromEntries(['opening','8','9','10','11','12','13','14','15','16'].map(key=>[key,opening])),_operation:freshOperation()}),config,settings:{paused:settings.paused,approval:settings.approval},frozen:[]}));
  const first=JSON.parse(db.prepare('SELECT snapshot FROM event_sessions WHERE session=1').get().snapshot);
  db.prepare("UPDATE theater_state SET cue=1,mode='opening',story_id=NULL,session=1,credits_run=0,cue_bgm=?,revision=revision+1 WHERE id=1").run(first.cue_bgm);
  db.exec('DELETE FROM frozen; UPDATE settings SET revision=revision+1 WHERE id=1; PRAGMA user_version=7;');
 });
}
// Caller owns BEGIN IMMEDIATE and global revision CAS, and checkpoints the source timeline.
export function switchSession(db,session,at=Date.now()) {
 const row=db.prepare('SELECT * FROM theater_state WHERE id=1').get();
 const config=db.prepare('SELECT config FROM event_config').get().config;
 const settings=db.prepare('SELECT paused,approval FROM settings WHERE id=1').get();
 const frozen=db.prepare('SELECT id FROM frozen').all().map(x=>x.id);
 const {cue,mode,story_id,credits_run,cue_bgm}=row;
 db.prepare('UPDATE event_sessions SET snapshot=? WHERE session=?').run(JSON.stringify({cue,mode,story_id,credits_run,cue_bgm,config,settings,frozen}),row.session);
 const target=JSON.parse(db.prepare('SELECT snapshot FROM event_sessions WHERE session=?').get(session).snapshot);
 const bgm=JSON.parse(target.cue_bgm),op={...freshOperation(),...bgm._operation};bgm._operation=op;
 // An inactive session never accrues time, including old snapshots saved running.
 op.randomSeed??=op.runId;op.timelineAt=at;op.paused=true;op.pending=null;op.runId=randomBytes(16).toString('hex');
 db.prepare('UPDATE theater_state SET session=?,cue=?,mode=?,story_id=?,credits_run=?,cue_bgm=?,revision=revision+1 WHERE id=1').run(session,target.cue,target.mode,target.story_id,target.credits_run,JSON.stringify(bgm));
 db.prepare('UPDATE event_config SET config=?,version=version+1').run(target.config);
 db.prepare('UPDATE settings SET paused=?,approval=?,revision=revision+1 WHERE id=1').run(target.settings.paused,target.settings.approval);
 db.exec('DELETE FROM frozen');for(const id of target.frozen)db.prepare('INSERT OR IGNORE INTO frozen SELECT id FROM memories WHERE id=? AND session=?').run(id,session);
}
