import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { MeetingRuntime } from '../dist/runtime.js';
import { followProcessing } from '../dist/follow_processing.js';
import { reportRefSchema, reportTaskSchema, reportSourcesShape } from '../dist/report_provenance.js';
import { z } from 'zod';

async function fixture(fn) {
  const root=mkdtempSync(join(tmpdir(),'pma-receipt-test-'));
  const r=new MeetingRuntime(root,join(root,'data'),true); r.mixer=()=>{};
  let now=100000; r.processing.now=()=>now;
  r.prepare('SYNTHETIC — NOT A MEETING',true); const id=r.session.id;
  const add=(text='ສະບາຍດີ',language='lo',boundary='')=>r.ingest(text,'synthetic_fixture',0,3,boundary,'synthetic',language,new Date().toISOString(),1);
  try { await fn({r,id,root,add,advance:ms=>now+=ms}); }
  finally { if(!r.closing) await r.close(); const abs=resolve(root); assert.ok(abs.startsWith(resolve(tmpdir())) && basename(abs).startsWith('pma-receipt-test-'));rmSync(abs,{recursive:true,force:true}); }
}
const claim=(r,id,role='chinh',ownerId='owner-a',extra={})=>r.processing.claim(id,{role,ownerId,...extra});
function request(r,c,extra={}) {
  const b=c.batch;assert.ok(b);
  const base={batchId:b.batchId,ownerId:c.ownerId,epoch:c.epoch};
  return b.role==='chinh' ? {...base,outputs:{picture:{text:'Synthetic picture: chưa merge; chỉ kiểm thử.',expectedPreviousRevision:r.picture(b.meetingId)?.revision ?? 0,anchors:[]}},...extra}
    : {...base,outputs:{translations:b.items.filter(x=>['lo','th'].includes(x.source.language)).map(x=>({sourceId:x.ref.sourceId,recheckId:x.ref.recheckId,text:'Synthetic translation '+(x.ref.sourceId ?? 'range:'+x.ref.recheckId),uncertainty:{state:'none'}}))},skips:b.items.filter(x=>x.source.language==='vi').map(x=>({sourceId:x.ref.sourceId,recheckId:x.ref.recheckId,kind:'pass_through_vi',reason:'Vietnamese original'})),...extra};
}

test('transport delivery does not advance processed state; killed follower reclaims immutable batch under new epoch',()=>fixture(async({r,id,add,advance})=>{
  const sid=add();const a=claim(r,id);const original=JSON.stringify(a.batch);
  r.processing.delivered(a.attemptId);assert.equal(r.processing.peek(id,'chinh').cursor,0);
  assert.equal(claim(r,id,'chinh','owner-b').busy,true);
  advance(31000);const b=claim(r,id,'chinh','owner-b');assert.deepEqual(b.batch,JSON.parse(original));assert.ok(b.epoch>a.epoch);
  assert.throws(()=>r.processingCommit(request(r,a)),/STALE_PROCESSING_OWNER/);
  const result=r.processingCommit(request(r,b));assert.equal(result.cursor,sid);assert.equal(r.processing.peek(id,'chinh').count,0);
  assert.equal(r.processing.peek(id,'dich').count,1);
}));

test('reply lost after commit is idempotent; changed retry conflicts without overwriting history',()=>fixture(({r,id,add})=>{
  add();const c=claim(r,id,'dich');const req=request(r,c);const one=r.processingCommit(req);const two=r.processingCommit(req);
  assert.equal(one.duplicate,false);assert.equal(two.duplicate,true);
  assert.equal(r.db.prepare('SELECT COUNT(*) AS n FROM processing_receipts').get().n,1);
  const changed=structuredClone(req);changed.outputs.translations[0].text='Different text';assert.throws(()=>r.processingCommit(changed),/PROCESSING_CONFLICT/);
  assert.equal(r.db.prepare('SELECT text FROM translations').get().text,req.outputs.translations[0].text);
}));

test('failure between artifact and receipt rolls back all SQLite changes and leaves source pending',()=>fixture(({r,id,add})=>{
  const sid=add();const c=claim(r,id,'dich');const req=request(r,c);
  assert.throws(()=>r.processing.commit(req,()=>{r.db.prepare('INSERT INTO translations VALUES(?,?,?,?)').run(sid,id,'partial','fixture');throw new Error('INJECTED_CRASH');}),/INJECTED_CRASH/);
  assert.equal(r.db.prepare('SELECT COUNT(*) AS n FROM translations').get().n,0);
  assert.equal(r.db.prepare('SELECT COUNT(*) AS n FROM processing_receipts').get().n,0);
  assert.equal(r.processing.peek(id,'dich').cursor,0);assert.equal(claim(r,id,'dich').batch.batchId,c.batch.batchId);
  assert.equal(r.processingCommit(req).saved,true);
}));

test('SQLite reopen preserves pending receipts and can finish an ended historical meeting without capture',()=>fixture(async({r,id,root,add})=>{
  add();const c=claim(r,id,'dich');await r.close();
  const next=new MeetingRuntime(root,join(root,'data'),true);next.mixer=()=>{};next.processing.now=()=>200000;
  try {const resumed=claim(next,id,'dich','owner-after-crash');assert.equal(resumed.batch.batchId,c.batch.batchId);assert.equal(next.processingCommit(request(next,resumed)).saved,true);assert.equal(next.capture,null);assert.equal(next.recorderAlive(),false);}
  finally{await next.close();}
}));

test('100 source backlog is capped40 and processes without loss or foreign-meeting ID assumptions',()=>fixture(({r,id,add})=>{
  for(let i=0;i<100;i++) add('row '+i,'vi');
  const sizes=[];let seen=0;
  for(let i=0;i<3;i++){const c=claim(r,id);sizes.push(c.batch.items.length);seen+=c.batch.items.length;r.processingCommit(request(r,c));}
  assert.deepEqual(sizes,[40,40,20]);assert.equal(seen,100);assert.equal(r.processing.peek(id,'chinh').count,0);
  assert.equal(r.db.prepare('SELECT COUNT(*) AS n FROM processing_receipts WHERE role=?').get('chinh').n,100);
}));

test('source-bound recheck invalidates pending snapshot and requeues both roles after commit, preserving source',()=>fixture(({r,id,add})=>{
  const sid=add();const sourceBefore=r.sources(id)[0].text;
  for(const role of ['chinh','dich']){const c=claim(r,id,role);r.processingCommit(request(r,c));}
  const row=r.db.prepare('INSERT INTO rechecks(session_id,source_id,from_wall,to_wall,channel,text,language,alternatives,silent,created) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,sid,'2026-10-31T00:00:00Z','2026-10-31T00:00:03Z','speaker','ກວດຄືນ','lo','[]',0,'fixture');
  for(const role of ['chinh','dich']){const c=claim(r,id,role);assert.equal(c.batch.items[0].ref.recheckId,Number(row.lastInsertRowid));r.processingCommit(request(r,c));}
  assert.equal(r.sources(id)[0].text,sourceBefore);assert.equal(r.db.prepare('SELECT COUNT(*) AS n FROM processing_receipts').get().n,4);
}));

test('stale picture and dropped/provenance-mutated anchors are rejected; legacy cannot erase structured checkpoint',()=>fixture(({r,id,add})=>{
  const sid=add();const c=claim(r,id);const req=request(r,c);req.outputs.picture.anchors=[{key:'decision:no-merge',text:'Chưa merge',state:'open',sourceIds:[sid]}];r.processingCommit(req);
  assert.throws(()=>r.savePicture(id,'legacy erase',[sid]),/STRUCTURED_PICTURE/);
  const next=add();const d=claim(r,id);const stale=request(r,d);stale.outputs.picture.expectedPreviousRevision=0;assert.throws(()=>r.processingCommit(stale),/STALE_PICTURE/);
  assert.throws(()=>r.processingCommit(request(r,d)),/ANCHOR_DROPPED/);
  const valid=request(r,d);valid.outputs.picture.anchors=req.outputs.picture.anchors;r.processingCommit(valid);assert.equal(r.picture(id).revision,2);
}));

test('RAW is postcommit derived output; SQLite success is not filesystem completion; unclear flag survives export',()=>fixture(({r,id,add})=>{
  const sid=add();const c=claim(r,id,'dich');const req=request(r,c);req.outputs.translations[0].uncertainty={state:'unclear',reason:'Số chưa chắc'};
  const done=r.processingCommit(req);assert.equal(done.rawProjection,'pending');assert.equal(r.processing.projection(id).completedRevision,0);
  assert.equal(r.processing.projected(id,99,'stale'),false);
  const exported=r.writeRaw(id);assert.equal(exported.rawProjection.completed,true);assert.match(readFileSync(exported.path,'utf8'),/Số chưa chắc/);
  assert.equal(r.processing.projection(id).completedRevision,1);
}));

test('incomplete or invalid role outputs roll back; no silent pass for an untranslated Lao row',()=>fixture(({r,id,add})=>{
  add();const c=claim(r,id,'dich');const req=request(r,c);req.outputs.translations=[];
  assert.throws(()=>r.processingCommit(req),/INCOMPLETE/);assert.equal(r.processing.peek(id,'dich').count,1);
  req.skips=[{sourceId:c.batch.items[0].ref.sourceId,kind:'pass_through_vi',reason:'wrong language'}];assert.throws(()=>r.processingCommit(req),/SKIP_REQUIRES_VI/);
}));

test('processor generation has separate identity and release cannot clear another namespace lease',()=>fixture(({r,id,add})=>{
  add();const a=claim(r,id);const b=claim(r,id,'chinh','owner-a',{generation:1,reason:'Explicit synthetic reprocess'});
  assert.notEqual(a.batch.batchId,b.batch.batchId);r.processing.release(id,'chinh','owner-a',a.epoch);
  const states=r.processing.status(id,'chinh').states;assert.equal(states.find(x=>x.generation===0).lease_until,0);assert.ok(states.find(x=>x.generation===1).lease_until>0);
}));

test('receipt follow adapter renews from committed state, surfaces health, and does not call daemon/capture',()=>fixture(async({r,id,add,advance})=>{
  add();let time=0;const emitted=[];const methods=[];let commits=0;
  const rpc=async(method,a={})=>{
    methods.push(method);
    if(method==='status')return {session:{id}};
    if(method==='processingPeek'){const p=r.processingPeek(id,a.role);p.health.recorderError='synthetic device error';return p;}
    if(method==='processingClaim')return r.processing.claim(id,a);
    if(method==='processingDelivered')return r.processing.delivered(a.attemptId);
    if(method==='processingRelease')return r.processing.release(id,a.role,a.ownerId,a.epoch,a.processorRevision,a.generation);
    throw new Error('Unexpected method '+method);
  };
  await followProcessing({as:'chinh',batch:'1',minutes:'0.1'},rpc,line=>{
    emitted.push(line);
    if(line.startsWith('PMA_RECEIPT_V1 ')){const meta=JSON.parse(line.slice(15));const c={batch:r.processing.manifest(meta.batchId),ownerId:meta.ownerId,epoch:meta.epoch};r.processingCommit(request(r,c));commits++;}
  },items=>items.map(x=>x.text),()=>time,async ms=>{time+=ms;advance(ms);});
  assert.equal(commits,1);assert.ok(emitted.some(x=>x.startsWith('HEALTH ')));assert.ok(emitted.some(x=>x.startsWith('BẬT LẠI')));
  assert.ok(!methods.some(x=>['prepare','listen','start','open'].includes(x)));
}));

const attributionCases=[
 ['called A, B answers','Anh A ơi. Vâng tôi trả lời.',{candidateName:'A',identityState:'candidate',evidenceRef:{kind:'called_name',ref:'fixture:called-A'}},'candidate'],
 ['self identification unverified','Tôi là B',{candidateName:'B',identityState:'candidate',evidenceRef:{kind:'self_declared',ref:'fixture:ASR-only'}},'candidate'],
 ['two people share mic','hai người',{sharedMic:true,candidateName:'A',evidenceRef:{kind:'shared_microphone',ref:'fixture:shared'}},'unknown'],
 ['overlap','chồng tiếng',{overlap:true,acousticSpeakerLabel:'anon:A',evidenceRef:{kind:'overlap',ref:'fixture:overlap'}},'unknown'],
 ['free floor','cả phòng nói',{evidenceRef:{kind:'free_floor',ref:'fixture:room'}},'unknown'],
 ['Lao Vietnamese Thai code switch','ສະບາຍດີ xin chào สวัสดี',{acousticSpeakerLabel:'anon:A',evidenceRef:{kind:'code_switch',ref:'fixture:mixed'}},'unknown'],
 ['quoted task names are not assignees','A nói B sẽ làm theo lời C',{candidateName:'B',evidenceRef:{kind:'person_mention',ref:'fixture:quote'}},'candidate'],
];
for(const [name,source,extra,expected] of attributionCases)test('attribution: '+name,()=>fixture(({r,id,add})=>{
  const sid=add(source);const result=r.processing.attribution(id,sid,{channel:'speaker',...extra},0);
  assert.equal(result.attribution.identityState,expected);assert.ok(!('assignee' in result.attribution));
  assert.throws(()=>r.processing.attribution(id,sid,{channel:'speaker',identityState:'human_confirmed',candidateName:'A',evidenceRef:{kind:'called_name',ref:'fixture:call'}},1),/HUMAN_CONFIRMATION/);
}));

test('attribution: explicit human correction replays SAME source to both roles without rewriting source history',()=>fixture(({r,id,add})=>{
  const sid=add('gọi A nhưng B trả lời');const original=r.sources(id)[0].text;
  for(const role of ['chinh','dich'])r.processingCommit(request(r,claim(r,id,role)));
  const corrected=r.processing.attribution(id,sid,{channel:'speaker',candidateName:'B',identityState:'human_confirmed',evidenceRef:{kind:'human_correction',ref:'fixture:owner-explicit'}},0,true);
  assert.equal(corrected.attribution.identityState,'human_confirmed');
  for(const role of ['chinh','dich']){const c=claim(r,id,role);assert.equal(c.batch.items[0].ref.sourceId,sid);assert.equal(c.batch.items[0].source.attribution.correctionRevision,1);r.processingCommit(request(r,c));}
  assert.equal(r.sources(id)[0].text,original);assert.equal(r.db.prepare('SELECT COUNT(*) AS n FROM processing_receipts').get().n,4);
}));

test('attribution cannot turn speaker loopback into bound mic or derive task owner',()=>fixture(({r,id,add})=>{
  const sid=add();assert.throws(()=>r.processing.attribution(id,sid,{channel:'mic',identityState:'channel_bound',evidenceRef:{kind:'channel_metadata',ref:'fake'}},0),/CHANNEL_MISMATCH/);
  assert.throws(()=>r.processing.attribution(id,sid,{channel:'speaker',identityState:'channel_bound',candidateName:'A',evidenceRef:{kind:'channel_metadata',ref:'fake'}},0),/REQUIRES_CAPTURED_MIC/);
  assert.throws(()=>r.processing.attribution(id,sid,{channel:'speaker',assignee:'A'},0),/NOT_ASSIGNMENT/);
}));

test('pending input revised by recheck rejects old commit and offers updated immutable snapshot',()=>fixture(({r,id,add})=>{
  const sid=add();const old=claim(r,id,'dich');
  r.db.prepare('INSERT INTO rechecks(session_id,source_id,from_wall,to_wall,channel,text,language,alternatives,silent,created) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,sid,'2026-10-31T00:00:00Z','2026-10-31T00:00:03Z','speaker','new hearing','lo','[]',0,'fixture');
  assert.throws(()=>r.processingCommit(request(r,old)),/STALE_PROCESSING_INPUT/);
  const updated=claim(r,id,'dich');assert.notEqual(updated.batch.batchId,old.batch.batchId);assert.equal(updated.progress,0);r.processingCommit(request(r,updated));
}));

test('provenance-only anchor rewrite without current evidence is rejected',()=>fixture(({r,id,add})=>{
  const first=add();const second=add();const a=claim(r,id);const req=request(r,a);
  req.outputs.picture.anchors=[{key:'decision:test',text:'Giữ nguyên',state:'open',sourceIds:[first]}];r.processingCommit(req);
  add();const b=claim(r,id);const changed=request(r,b);changed.outputs.picture.anchors=[{key:'decision:test',text:'Giữ nguyên',state:'open',sourceIds:[second]}];
  assert.throws(()=>r.processingCommit(changed),/ANCHOR_CHANGE_NEEDS_CURRENT_SOURCE/);assert.equal(r.picture(id).revision,1);
}));

test('range recheck without sourceId is a durable work item for both roles, without fabricated source IDs',()=>fixture(({r,id,add})=>{
  add('earlier');for(const role of ['chinh','dich'])r.processingCommit(request(r,claim(r,id,role)));
  const before=r.db.prepare('SELECT COUNT(*) AS n FROM sources').get().n;
  const range=r.db.prepare('INSERT INTO rechecks(session_id,source_id,from_wall,to_wall,channel,text,language,alternatives,silent,created) VALUES(?,NULL,?,?,?,?,?,?,?,?)').run(id,'2026-10-31T00:01:00Z','2026-10-31T00:01:03Z','speaker','ກວດຄືນ','lo','[]',0,'fixture');
  const rid=Number(range.lastInsertRowid);
  for(const role of ['chinh','dich']){
    const c=claim(r,id,role);assert.equal(c.batch.items.length,1);assert.equal(c.batch.items[0].ref.sourceId,null);assert.equal(c.batch.items[0].ref.recheckId,rid);
    const req=request(r,c);r.processingCommit(req);assert.equal(r.processing.peek(id,role).count,0);assert.equal(r.processing.peek(id,role).pendingRangeRechecks.length,0);
  }
  assert.deepEqual(r.picture(id).sourceIds,[]);assert.deepEqual(r.picture(id).recheckIds,[rid]);
  assert.equal(r.db.prepare('SELECT COUNT(*) AS n FROM sources').get().n,before);
  assert.equal(r.db.prepare('SELECT COUNT(*) AS n FROM processing_receipts WHERE source_id IS NULL AND recheck_id=?').get(rid).n,2);
  assert.match(readFileSync(r.writeRaw(id).path,'utf8'),new RegExp('Synthetic translation range:'+rid));
}));

test('range uncertainty is exported and receipt follow cannot say finished before range commit',()=>fixture(async({r,id})=>{
  const row=r.db.prepare('INSERT INTO rechecks(session_id,source_id,from_wall,to_wall,channel,text,language,alternatives,silent,created) VALUES(?,NULL,?,?,?,?,?,?,?,?)').run(id,'2026-10-31T00:01:00Z','2026-10-31T00:01:03Z','speaker','range','lo','[]',0,'fixture');
  r.db.prepare('UPDATE sessions SET ended=? WHERE id=?').run('fixture-end',id);
  let time=0,meta=null,committed=false;const emitted=[];
  const rpc=async(method,a={})=>{
    if(method==='status')return {session:{id}};
    if(method==='processingPeek')return r.processingPeek(id,a.role);
    if(method==='processingClaim')return r.processing.claim(id,a);
    if(method==='processingDelivered')return r.processing.delivered(a.attemptId);
    if(method==='processingRelease')return r.processing.release(id,a.role,a.ownerId,a.epoch,a.processorRevision,a.generation);
    throw new Error(method);
  };
  await followProcessing({as:'dich',batch:'15',minutes:'0.1'},rpc,line=>{
    emitted.push(line);if(line.startsWith('PMA_RECEIPT_V1 '))meta=JSON.parse(line.slice(15));
    if(line.startsWith('KẾT THÚC'))assert.equal(committed,true);
  },items=>items.map(x=>x.text),()=>time,async ms=>{
    time+=ms;
    if(time>=2000 && meta && !committed){const c={batch:r.processing.manifest(meta.batchId),ownerId:meta.ownerId,epoch:meta.epoch};const req=request(r,c);req.outputs.translations[0].uncertainty={state:'unclear',reason:'Range số chưa rõ'};r.processingCommit(req);committed=true;}
  });
  assert.equal(committed,true);assert.ok(emitted.some(x=>x.startsWith('KẾT THÚC')));assert.match(readFileSync(r.writeRaw(id).path,'utf8'),/Range số chưa rõ/);
}));

test('source IDs interleaved with a foreign meeting do not create a false gap or receipt',()=>fixture(({r,id,add})=>{
  const first=add();
  const foreign='00000000-0000-4000-8000-000000000002';r.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run(foreign,'foreign','fixture',null,'FIXTURE_NOT_MEETING','{}');
  const alien=r.db.prepare('INSERT INTO sources(session_id,text,origin,start,end,created,boundary) VALUES(?,?,?,?,?,?,?)').run(foreign,'foreign','synthetic_fixture',0,1,'fixture','');
  const second=add();assert.ok(second>first+1);
  const c=claim(r,id);assert.deepEqual(c.batch.items.map(x=>x.ref.sourceId),[first,second]);
  assert.equal(r.processingCommit(request(r,c)).cursor,second);assert.equal(r.db.prepare('SELECT COUNT(*) AS n FROM processing_receipts WHERE source_id=?').get(Number(alien.lastInsertRowid)).n,0);
}));

test('two independent range corrections survive reply loss and remain distinct when sourceId is null',()=>fixture(({r,id})=>{
  for(let i=0;i<2;i++)r.db.prepare('INSERT INTO rechecks(session_id,source_id,from_wall,to_wall,channel,text,language,alternatives,silent,created) VALUES(?,NULL,?,?,?,?,?,?,?,?)').run(id,'2026-10-31T00:01:00Z','2026-10-31T00:01:03Z','speaker','range '+i,'lo','[]',0,'fixture');
  const c=claim(r,id,'dich');assert.equal(c.batch.items.length,2);const req=request(r,c);assert.equal(r.processingCommit(req).processed,2);assert.equal(r.processingCommit(req).duplicate,true);
  assert.equal(r.db.prepare('SELECT COUNT(*) AS n FROM processing_receipts').get().n,2);
}));

const reportRange=(r,id,text='Public fixture recovered fact',from='2026-10-31T00:01:00Z',to='2026-10-31T00:01:03Z',sourceId=null)=>Number(r.db.prepare('INSERT INTO rechecks(session_id,source_id,from_wall,to_wall,channel,text,language,alternatives,silent,created) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,sourceId,from,to,'speaker',text,'lo','[]',0,'fixture').lastInsertRowid);

test('range-only summary and tasks retain real typed evidence, times and no fabricated source IDs',()=>fixture(({r,id})=>{
  const recheckId=reportRange(r,id);const refs=r.reportSources(id,[],[{sourceId:null,recheckId}]);
  const summary=r.saveSummary(id,'- Recovered unverified fact.',[],refs);
  const tasks=r.saveTasks(id,[{task:'Check recovered fact; owner not stated',sourceRefs:refs}]);
  assert.match(readFileSync(summary.path,'utf8'),new RegExp('recheck:'+recheckId));assert.match(readFileSync(tasks.path,'utf8'),new RegExp('recheck:'+recheckId));
  const history=r.reportHistory(id);assert.equal(history.length,2);
  for(const report of history){assert.deepEqual(report.sourceIds,[]);assert.equal(report.sourceRefs[0].sourceId,null);assert.equal(report.sourceRefs[0].recheckId,recheckId);assert.equal(report.sourceRefs[0].fromWall,'2026-10-31T00:01:00Z');assert.equal(report.sourceRefs[0].text,'Public fixture recovered fact');assert.equal(report.sourceRefs[0].inputHash.length,64);}
  assert.equal(r.db.prepare('SELECT COUNT(*) AS n FROM sources').get().n,0);assert.equal(history[1].taskRefs[0][0].recheckId,recheckId);
}));

test('mixed numeric and typed report evidence preserves legacy readers and task owner rules',()=>fixture(({r,id,add})=>{
  const sourceId=add('Original source','vi');const recheckId=reportRange(r,id);
  const result=r.saveSummary(id,'Mixed evidence',[sourceId],[{recheckId}]);
  assert.match(readFileSync(result.path,'utf8'),new RegExp('#'+sourceId));assert.match(r.reportFile(id,'summary').content,new RegExp('recheck:'+recheckId));
  const task=r.saveTasks(id,[{task:'Stated action',sourceIds:[sourceId],sourceRefs:[{recheckId}]}]);
  const h=r.reportHistory(id,'tasks')[0];assert.deepEqual(h.sourceIds,[sourceId]);assert.equal(h.sourceRefs.length,2);assert.equal(h.taskRefs[0].length,2);assert.doesNotMatch(readFileSync(task.path,'utf8'),/human_confirmed|candidateName/);
}));

test('report refs reject foreign or missing evidence and bad times without appending a report',()=>fixture(({r,id,add})=>{
  add();const foreign='00000000-0000-4000-8000-000000000007';r.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run(foreign,'foreign','fixture',null,'FIXTURE','{}');
  const recheckId=reportRange(r,foreign);assert.throws(()=>r.saveSummary(id,'Foreign',[],[{recheckId}]),/RECHECK_OUTSIDE_SESSION/);
  assert.throws(()=>r.saveTasks(id,[{task:'Missing',sourceRefs:[{recheckId:99999}]}]),/RECHECK_OUTSIDE_SESSION/);
  const malformed=reportRange(r,id,'Bad time','invalid','invalid');assert.throws(()=>r.reportSources(id,[],[{recheckId:malformed}]),/INVALID_REPORT_TIME_RANGE/);
  const valid=reportRange(r,id);assert.throws(()=>r.saveSummary(id,'Wrong time',[],[{recheckId:valid,fromWall:'2026-10-31T00:02:00Z'}]),/REPORT_TIME_OR_CAPTURE_MISMATCH/);
  assert.equal(r.reportHistory(id).length,0);
}));

test('source-bound correction invalidates pinned report snapshot and retains previous report text and evidence',()=>fixture(({r,id,add})=>{
  const sourceId=add('Original fact');const refs=r.reportSources(id,[sourceId]);r.saveSummary(id,'Original summary',[],refs);
  const recheckId=reportRange(r,id,'Corrected fact',undefined,undefined,sourceId);
  assert.throws(()=>r.saveSummary(id,'Stale new summary',[],refs),/STALE_REPORT_REFERENCE/);
  const updated=r.reportSources(id,[sourceId]);assert.equal(updated[0].recheckId,recheckId);r.saveSummary(id,'Corrected summary',[],updated);
  const h=r.reportHistory(id,'summary');assert.equal(h.length,2);assert.equal(h[0].sourceRefs[0].text,'Original fact');assert.equal(h[1].sourceRefs[0].text,'Corrected fact');assert.notEqual(h[0].sourceRefs[0].inputHash,h[1].sourceRefs[0].inputHash);assert.match(h[0].content,/Original summary/);
}));

test('new exact-range correction supersedes old report refs while immutable history remains readable',()=>fixture(({r,id})=>{
  const first=reportRange(r,id,'First range');const refs=r.reportSources(id,[],[{recheckId:first}]);r.saveTasks(id,[{task:'Initial action',sourceRefs:refs}]);
  const next=reportRange(r,id,'Corrected range');assert.throws(()=>r.saveTasks(id,[{task:'Stale action',sourceRefs:refs}]),/STALE_REPORT_REFERENCE/);
  r.saveTasks(id,[{task:'Corrected action',sourceRefs:[{recheckId:next}]}]);const h=r.reportHistory(id,'tasks');assert.equal(h.length,2);assert.equal(h[0].sourceRefs[0].text,'First range');assert.equal(h[1].sourceRefs[0].recheckId,next);
}));

test('report retry is idempotent and a historical duplicate cannot roll current SUMMARY file backwards',()=>fixture(({r,id,add})=>{
  const sourceId=add('Fact');const one=r.saveSummary(id,'First summary',[sourceId]);const duplicate=r.saveSummary(id,'First summary',[sourceId]);
  assert.equal(duplicate.duplicate,true);assert.equal(duplicate.reportId,one.reportId);
  r.saveSummary(id,'Second summary',[sourceId]);const old=r.saveSummary(id,'First summary',[sourceId]);assert.equal(old.duplicate,true);assert.match(readFileSync(old.path,'utf8'),/Second summary/);assert.equal(r.reportHistory(id).length,2);
}));

test('report DB commit survives projection failure and identical retry rebuilds without another revision',()=>fixture(({r,id,add,root})=>{
  const sourceId=add('Projection fact');const reportDir=r.reportDir(id);mkdirSync(join(reportDir,'SUMMARY.md'));
  assert.throws(()=>r.saveSummary(id,'Committed despite projection failure',[sourceId]));assert.equal(r.reportHistory(id,'summary').length,1);assert.match(r.reportFile(id,'summary').content,/Committed despite projection failure/);
  assert.equal(r.reportHistory(id,'summary')[0].fileProjection.pending,true);assert.equal(r.reportFile(id,'summary').fileProjection.completedReportId,null);
  rmSync(join(reportDir,'SUMMARY.md'),{recursive:true});const retry=r.saveSummary(id,'Committed despite projection failure',[sourceId]);assert.equal(retry.duplicate,true);assert.equal(r.reportHistory(id).length,1);assert.match(readFileSync(retry.path,'utf8'),/Committed despite projection failure/);assert.equal(retry.fileProjection.pending,false);assert.equal(retry.fileProjection.completedReportId,retry.reportId);assert.equal(retry.fileProjection.contentHash.length,64);
}));

test('numeric zero-duration sources and old report rows stay readable without fabricated timestamps',()=>fixture(({r,id})=>{
  const sourceId=r.ingest('Manual point source','synthetic_fixture',0,0,'','fixture','vi');const saved=r.saveSummary(id,'Legacy point',[sourceId]);assert.ok(saved.saved);
  r.db.prepare('INSERT INTO reports(session_id,kind,content,source_ids,created) VALUES(?,?,?,?,?)').run(id,'tasks','legacy saved text',JSON.stringify([sourceId]),'fixture');const old=r.reportHistory(id,'tasks')[0];assert.equal(old.legacyProvenance,true);assert.equal(old.sourceRefs,null);assert.deepEqual(old.sourceIds,[sourceId]);assert.equal(r.reportFile(id,'tasks').content,'legacy saved text');
}));

test('shared MCP/RPC report schemas allow range-only refs, preserve legacy numeric input and reject malformed refs',()=>{
  const summary=z.object({markdown:z.string(),...reportSourcesShape});assert.ok(summary.parse({markdown:'x',sourceRefs:[{sourceId:null,recheckId:1}]}));assert.ok(summary.parse({markdown:'x',sourceIds:[1]}));assert.ok(reportTaskSchema.parse({task:'x',sourceRefs:[{recheckId:1}]}));
  assert.equal(reportRefSchema.safeParse({}).success,false);assert.equal(reportRefSchema.safeParse({recheckId:-1}).success,false);assert.equal(reportRefSchema.safeParse({recheckId:1,inputHash:'invented'}).success,false);
});

test('range picture provenance is visible in legacy text export instead of an empty numeric source label',()=>fixture(({r,id})=>{
  const recheckId=reportRange(r,id);const c=claim(r,id);const req=request(r,c);req.outputs.picture.anchors=[{key:'rangefact',text:'Recovered fact',state:'open',sourceIds:[],recheckIds:[recheckId]}];r.processingCommit(req);
  assert.match(r.exportText(id),new RegExp('recheck:'+recheckId));
}));

test('source-bound recheck reports the actual padded audio window and retains the original capture window',()=>fixture(({r,id})=>{
  const sourceId=r.ingest('Original','synthetic_fixture',5,8,'','capture-original','lo','2026-10-31T00:00:05Z',1);
  const recheckId=reportRange(r,id,'Rechecked words','2026-10-31T00:00:04Z','2026-10-31T00:00:09Z',sourceId);
  const ref=r.reportSources(id,[],[{recheckId}])[0];assert.equal(ref.fromWall,'2026-10-31T00:00:04Z');assert.equal(ref.toWall,'2026-10-31T00:00:09Z');assert.equal(ref.start,0);assert.equal(ref.end,5);assert.equal(ref.timeBasis,'wall_clock');assert.deepEqual(ref.originalSourceWindow,{start:5,end:8,wall:'2026-10-31T00:00:05.000Z',captureId:'capture-original'});
  r.saveSummary(id,'Padded-window evidence',[],[ref]);assert.match(r.reportHistory(id)[0].content,/00:00:04Z/);
  r.db.prepare('UPDATE rechecks SET to_wall=? WHERE id=?').run('2026-10-31T00:00:10Z',recheckId);assert.throws(()=>r.saveSummary(id,'Stale time',[],[ref]),/STALE_REPORT_REFERENCE/);
}));

test('committed report export can be repaired after evidence correction without re-saving stale interpretation',()=>fixture(({r,id,add})=>{
  const sourceId=add('Initial evidence');const refs=r.reportSources(id,[sourceId]);const saved=r.saveSummary(id,'Prior committed interpretation',[],refs);
  reportRange(r,id,'Updated evidence',undefined,undefined,sourceId);assert.throws(()=>r.saveSummary(id,'Prior committed interpretation',[],refs),/STALE_REPORT_REFERENCE/);
  rmSync(saved.path);const repaired=r.rebuildReport(id,'summary');assert.equal(repaired.fileProjection.pending,false);assert.match(readFileSync(repaired.path,'utf8'),/Prior committed interpretation/);assert.equal(r.reportHistory(id).length,1);assert.equal(r.reportHistory(id)[0].sourceRefs[0].text,'Initial evidence');
  assert.throws(()=>r.rebuildReport(id,'raw'),/UNKNOWN_REPORT/);assert.throws(()=>r.rebuildReport(id,'tasks'),/REPORT_NOT_CREATED_YET/);
}));
