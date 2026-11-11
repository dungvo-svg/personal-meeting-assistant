// Per-meeting, local processing receipts. No audio/device/network operations.
// A transport cursor is not an acknowledgement that Claude has processed text.
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type Role = 'chinh' | 'dich';
export const PROCESSOR_REVISION = 'pma-processing-v1';
export const PROCESSING_BATCH_CAP = 40;
export const canonical = (v: any): string => JSON.stringify(v, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, value[k]])) : value);
export const contentHash = (v: any) => createHash('sha256').update(canonical(v)).digest('hex');
const fail = (message: string): never => { throw new Error(message); };
const text = (v: any, max: number, name: string): string => typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : fail('INVALID_' + name);
const integer = (v: any, min: number, max: number, name: string) => Number.isSafeInteger(v) && v >= min && v <= max ? v : fail('INVALID_' + name);
const roleOf = (v: any): Role => v === 'chinh' || v === 'dich' ? v : fail('INVALID_PROCESSING_ROLE');

export type Attribution = {
  sourceId: number; startMs: number; endMs: number; timeBasis: 'source_relative_ms'; channel: 'speaker' | 'mic';
  acousticSpeakerLabel: string | null; identityState: 'unknown' | 'candidate' | 'channel_bound' | 'human_confirmed';
  candidateName: string | null; evidenceRef: { kind: string; ref: string }; correctionRevision: number;
  confidence: number | null; sharedMic: boolean; overlap: boolean;
};
export function attributionOf(raw: any, sourceId: number, durationMs: number, revision: number, ownerConfirmation = false): Attribution {
  if (!raw || typeof raw !== 'object' || raw.assignee !== undefined || raw.taskOwner !== undefined) fail('ATTRIBUTION_IS_NOT_ASSIGNMENT');
  const startMs = integer(raw.startMs ?? 0, 0, durationMs, 'ATTRIBUTION_START');
  const endMs = integer(raw.endMs ?? durationMs, startMs + 1, durationMs, 'ATTRIBUTION_END');
  const channel = raw.channel === 'mic' ? 'mic' : raw.channel === 'speaker' ? 'speaker' : fail('INVALID_ATTRIBUTION_CHANNEL');
  const kind = text(raw.evidenceRef?.kind, 60, 'ATTRIBUTION_EVIDENCE');
  const ref = text(raw.evidenceRef?.ref, 300, 'ATTRIBUTION_EVIDENCE_REF');
  const candidateName = raw.candidateName == null ? null : text(raw.candidateName, 120, 'CANDIDATE_NAME');
  const acousticSpeakerLabel = raw.acousticSpeakerLabel == null ? null : /^anon:[a-zA-Z0-9_-]{1,50}$/.test(raw.acousticSpeakerLabel) ? raw.acousticSpeakerLabel : fail('ACOUSTIC_LABEL_MUST_BE_ANONYMOUS');
  let identityState: Attribution['identityState'] = 'unknown';
  if (raw.identityState === 'human_confirmed') {
    if (!ownerConfirmation || kind !== 'human_correction' || !candidateName) fail('HUMAN_CONFIRMATION_REQUIRES_EXPLICIT_PROVENANCE');
    identityState = 'human_confirmed';
  } else if (raw.identityState === 'channel_bound' && kind === 'channel_metadata') identityState = 'channel_bound';
  else if (candidateName) identityState = 'candidate';
  if (raw.sharedMic === true || raw.overlap === true) identityState = 'unknown';
  const confidence = raw.confidence == null ? null : typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) && raw.confidence >= 0 && raw.confidence <= 1 ? raw.confidence : fail('INVALID_ATTRIBUTION_CONFIDENCE');
    return { sourceId, startMs, endMs, timeBasis: 'source_relative_ms', channel, acousticSpeakerLabel, identityState, candidateName:identityState==='channel_bound'?null:candidateName,
    evidenceRef: { kind, ref }, correctionRevision: revision, confidence, sharedMic: raw.sharedMic === true, overlap: raw.overlap === true };
}

export type Ref = { sourceId: number | null; recheckId: number | null; inputHash: string };
type Item = { ref: Ref; workKey: string; processingKey: string; source: any };
export type Manifest = { version: 1; meetingId: string; role: Role; processorRevision: string; generation: number; items: Item[]; batchId: string };
export type Claim = { batch: Manifest | null; ownerId: string; epoch: number; attemptId: string | null; busy?: boolean; leaseUntil: number; progress: number };

export class ProcessingLedger {
  now = () => Date.now();
  leaseMs = 30000;
  constructor(public db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS processing_manifests(id TEXT PRIMARY KEY,meeting_id TEXT NOT NULL,role TEXT NOT NULL,payload TEXT NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS processing_state(meeting_id TEXT NOT NULL,role TEXT NOT NULL,processor TEXT NOT NULL,generation INTEGER NOT NULL,owner TEXT NOT NULL,epoch INTEGER NOT NULL,lease_until INTEGER NOT NULL,cursor INTEGER NOT NULL,pending TEXT,PRIMARY KEY(meeting_id,role,processor,generation));
      CREATE TABLE IF NOT EXISTS processing_attempts(id TEXT PRIMARY KEY,batch_id TEXT NOT NULL,owner TEXT NOT NULL,epoch INTEGER NOT NULL,offered INTEGER NOT NULL,emitted INTEGER,received INTEGER,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS processing_receipts(meeting_id TEXT NOT NULL,role TEXT NOT NULL,processing_key TEXT NOT NULL,source_id INTEGER,recheck_id INTEGER,batch_id TEXT NOT NULL,payload TEXT NOT NULL,created TEXT NOT NULL,PRIMARY KEY(meeting_id,role,processing_key));
      CREATE TABLE IF NOT EXISTS processing_commits(batch_id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS processing_projections(meeting_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,completed_revision INTEGER NOT NULL DEFAULT 0,content_hash TEXT);
      CREATE TABLE IF NOT EXISTS attribution_revisions(meeting_id TEXT NOT NULL,source_id INTEGER NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,created TEXT NOT NULL,PRIMARY KEY(meeting_id,source_id,revision));
    `);
  }
  private meeting(id: string) { if (!this.db.prepare('SELECT 1 FROM sessions WHERE id=?').get(id)) fail('SESSION_NOT_FOUND'); }
  private namespace(id: string, role: Role, processor: string, generation: number) { return [id, role, processor, generation] as const; }
  private state(id: string, role: Role, processor: string, generation: number): any { return this.db.prepare('SELECT * FROM processing_state WHERE meeting_id=? AND role=? AND processor=? AND generation=?').get(...this.namespace(id, role, processor, generation)); }
  private source(id: string, sourceId: number): any {
    const s: any = this.db.prepare('SELECT id,text,origin,start,end,created AS createdAt,boundary,capture_id AS captureId,language,wall,seg,alternatives FROM sources WHERE session_id=? AND id=?').get(id, sourceId);
    if (!s) fail('SOURCE_OUTSIDE_SESSION');
    s.alternatives = JSON.parse(s.alternatives || '[]');
    const recheck: any = this.db.prepare('SELECT id,text,language,alternatives,silent,from_wall,to_wall,channel FROM rechecks WHERE session_id=? AND source_id=? ORDER BY id DESC LIMIT 1').get(id, sourceId);
    if (recheck) { s.text = recheck.silent ? '[chưa nghe rõ: nghe lại không có tiếng nói rõ]' : recheck.text; s.language = recheck.language || s.language; s.alternatives = JSON.parse(recheck.alternatives || '[]'); s.recheckRange={fromWall:recheck.from_wall,toWall:recheck.to_wall,channel:recheck.channel}; }
    const attr: any = this.db.prepare('SELECT payload FROM attribution_revisions WHERE meeting_id=? AND source_id=? ORDER BY revision DESC LIMIT 1').get(id, sourceId);
    s.attribution = attr ? JSON.parse(attr.payload) : null;
    return { source: s, recheckId: recheck?.id ?? null };
  }
  private item(id: string, sourceId: number, processor: string, generation: number): Item {
    const { source, recheckId } = this.source(id, sourceId);
    const inputHash = contentHash({ ...source, boundary: String(source.boundary).split(';').map(x => x.trim()).filter(x => x !== 'RECHECKED'), recheckId });
    const ref = { sourceId, recheckId, inputHash };
    const workKey = `source:${sourceId}:input:${inputHash}`;
    return { ref, workKey, processingKey: contentHash({ workKey, processor, generation }), source };
  }
  private rangeItem(id:string,recheckId:number,processor:string,generation:number):Item {
    const row:any=this.db.prepare('SELECT * FROM rechecks WHERE session_id=? AND id=? AND source_id IS NULL').get(id,recheckId);
    if(!row) fail('RANGE_RECHECK_OUTSIDE_SESSION');
    const source={id:'range:'+row.id,text:row.silent?'[chưa nghe rõ: khoảng nghe lại im lặng]':row.text,origin:'range_recheck_unverified',start:0,end:Math.max(0,(Date.parse(row.to_wall)-Date.parse(row.from_wall))/1000),createdAt:row.created,wall:row.from_wall,captureId:'recheck:'+row.id,language:row.language,boundary:'RECHECKED; RANGE_RECHECK; '+(row.channel==='mic'?'CHANNEL_MIC':'CHANNEL_SPEAKER'),alternatives:JSON.parse(row.alternatives || '[]'),attribution:null,range:{fromWall:row.from_wall,toWall:row.to_wall}};
    const ref:Ref={sourceId:null,recheckId:row.id,inputHash:contentHash(source)};
    const workKey=`range-recheck:${row.id}:input:${ref.inputHash}`;
    return {ref,workKey,processingKey:contentHash({workKey,processor,generation}),source};
  }
  private currentItem(id:string,ref:Ref,processor:string,generation:number) { return ref.sourceId===null ? this.rangeItem(id,ref.recheckId!,processor,generation) : this.item(id,ref.sourceId,processor,generation); }
  // Read-only current evidence for reports; output can be pinned by inputHash.
  evidence(id:string,ref:{sourceId?:number|null;recheckId?:number|null}) {
    this.meeting(id);
    if(ref.sourceId!=null) {
      const item=this.item(id,ref.sourceId,PROCESSOR_REVISION,0);
      if(ref.recheckId!=null && ref.recheckId!==item.ref.recheckId) fail('STALE_REPORT_REFERENCE');
      return item;
    }
    const row:any=this.db.prepare('SELECT * FROM rechecks WHERE session_id=? AND id=?').get(id,ref.recheckId ?? -1);
    if(!row) fail('RECHECK_OUTSIDE_SESSION');
    if(row.source_id!==null) {
      const item=this.item(id,row.source_id,PROCESSOR_REVISION,0);
      if(item.ref.recheckId!==row.id) fail('STALE_REPORT_REFERENCE');
      return item;
    }
    if(this.db.prepare('SELECT 1 FROM rechecks WHERE session_id=? AND source_id IS NULL AND from_wall=? AND to_wall=? AND channel=? AND id>? LIMIT 1').get(id,row.from_wall,row.to_wall,row.channel,row.id)) fail('STALE_REPORT_REFERENCE');
    return this.rangeItem(id,row.id,PROCESSOR_REVISION,0);
  }
  private receipted(id: string, role: Role, key: string) { return !!this.db.prepare('SELECT 1 FROM processing_receipts WHERE meeting_id=? AND role=? AND processing_key=?').get(id, role, key); }
  private pendingItems(id: string, role: Role, processor: string, generation: number, cursor: number) {
    const rows: any[] = this.db.prepare('SELECT id FROM sources WHERE session_id=? AND id>? ORDER BY id LIMIT 40').all(id, cursor);
    const corrected: any[] = this.db.prepare('SELECT source_id AS id FROM rechecks WHERE session_id=? AND source_id IS NOT NULL UNION SELECT source_id AS id FROM attribution_revisions WHERE meeting_id=?').all(id, id);
    const ids = [...new Set([...rows, ...corrected].map(r => Number(r.id)))].sort((a,b) => a-b);
    const ranges:any[]=this.db.prepare('SELECT id FROM rechecks WHERE session_id=? AND source_id IS NULL ORDER BY id').all(id);
    return [...ranges.map(r=>this.rangeItem(id,r.id,processor,generation)),...ids.map(sourceId => this.item(id, sourceId, processor, generation))].filter(x => !this.receipted(id, role, x.processingKey)).slice(0, PROCESSING_BATCH_CAP);
  }
  claim(id: string, input: { role: Role; ownerId: string; processorRevision?: string; generation?: number; reason?: string }): Claim {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = this.claimNow(id,input); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private claimNow(id: string, input: { role: Role; ownerId: string; processorRevision?: string; generation?: number; reason?: string }): Claim {
    this.meeting(id); const role = roleOf(input.role); const owner = text(input.ownerId, 150, 'PROCESSING_OWNER');
    const processor = text(input.processorRevision ?? PROCESSOR_REVISION, 120, 'PROCESSOR_REVISION'); const generation = integer(input.generation ?? 0, 0, 1000000, 'GENERATION');
    if (generation > 0) text(input.reason, 500, 'REPROCESS_REASON');
    this.db.prepare("INSERT OR IGNORE INTO processing_state VALUES(?,?,?,?, '',0,0,0,NULL)").run(id, role, processor, generation);
    let state = this.state(id, role, processor, generation); const now = this.now();
    if (state.owner !== owner && state.lease_until > now) return { batch:null, ownerId:owner, epoch:state.epoch, attemptId:null, busy:true, leaseUntil:state.lease_until, progress:state.cursor };
    const changedOwner = state.owner !== owner || state.lease_until <= now;
    const epoch = state.epoch + (changedOwner ? 1 : 0);
    this.db.prepare('UPDATE processing_state SET owner=?,epoch=?,lease_until=? WHERE meeting_id=? AND role=? AND processor=? AND generation=?').run(owner, epoch, now + this.leaseMs, ...this.namespace(id, role, processor, generation));
    let batch: Manifest | null = state.pending ? this.manifest(state.pending) : null;
    if (batch && batch.items.some(x => this.currentItem(id, x.ref, processor, generation).ref.inputHash !== x.ref.inputHash)) {
      this.db.prepare("UPDATE processing_attempts SET state='superseded_input' WHERE batch_id=? AND state='offered'").run(batch.batchId);
      batch = null;
    }
    if (!batch) {
      const items = this.pendingItems(id, role, processor, generation, state.cursor);
      if (items.length) {
        const immutable = { version:1 as const, meetingId:id, role, processorRevision:processor, generation, items };
        batch = { ...immutable, batchId:contentHash(immutable) };
        this.db.prepare('INSERT OR IGNORE INTO processing_manifests VALUES(?,?,?,?,?)').run(batch.batchId,id,role,canonical(batch),new Date(now).toISOString());
      }
      this.db.prepare('UPDATE processing_state SET pending=? WHERE meeting_id=? AND role=? AND processor=? AND generation=?').run(batch?.batchId ?? null,...this.namespace(id,role,processor,generation));
    }
    let attempt: any = batch ? this.db.prepare('SELECT id FROM processing_attempts WHERE batch_id=? AND owner=? AND epoch=? ORDER BY offered DESC LIMIT 1').get(batch.batchId,owner,epoch) : null;
    if (batch && !attempt) {
      attempt = {id:randomUUID()}; this.db.prepare('INSERT INTO processing_attempts VALUES(?,?,?,?,?,NULL,NULL,?)').run(attempt.id,batch.batchId,owner,epoch,now,'offered');
    }
    return { batch, ownerId:owner, epoch, attemptId:attempt?.id ?? null, leaseUntil:now+this.leaseMs, progress:state.cursor };
  }
  manifest(batchId: string): Manifest { const r: any = this.db.prepare('SELECT payload FROM processing_manifests WHERE id=?').get(batchId); return r ? JSON.parse(r.payload) : fail('BATCH_NOT_FOUND'); }
  peek(id: string, role: Role) {
    this.meeting(id); role=roleOf(role);
    const state=this.state(id,role,PROCESSOR_REVISION,0); const items=this.pendingItems(id,role,PROCESSOR_REVISION,0,state?.cursor ?? 0);
    const pendingRangeRechecks=items.filter(x=>x.ref.sourceId===null).map(x=>({recheckId:x.ref.recheckId,...x.source.range}));
    return { count:items.length, hasTai:items.some(x=>['lo','th'].includes(x.source.language)), pendingBatchId:state?.pending ?? null, cursor:state?.cursor ?? 0, pendingRangeRechecks };
  }
  release(id: string, role: Role, ownerId: string, epoch: number, processor=PROCESSOR_REVISION, generation=0) {
    const result=this.db.prepare('UPDATE processing_state SET lease_until=0 WHERE meeting_id=? AND role=? AND processor=? AND generation=? AND owner=? AND epoch=?').run(id,roleOf(role),processor,generation,ownerId,epoch);
    return {released:!!result.changes,processed:false};
  }
  delivered(attemptId: string) { if (!this.db.prepare('UPDATE processing_attempts SET emitted=? WHERE id=?').run(this.now(),attemptId).changes) fail('ATTEMPT_NOT_FOUND'); return { emitted:true, processed:false }; }
  status(id: string, role: Role) { this.meeting(id); return {states:this.db.prepare('SELECT processor,generation,cursor,pending,epoch,lease_until FROM processing_state WHERE meeting_id=? AND role=?').all(id,roleOf(role)),pendingRangeRechecks:this.peek(id,role).pendingRangeRechecks,rawProjection:this.projection(id)}; }
  private advance(batch: Manifest) {
    const state = this.state(batch.meetingId,batch.role,batch.processorRevision,batch.generation); let cursor = state.cursor;
    const rows: any[] = this.db.prepare('SELECT id FROM sources WHERE session_id=? AND id>? ORDER BY id').all(batch.meetingId,cursor);
    for (const row of rows) { const item = this.item(batch.meetingId,row.id,batch.processorRevision,batch.generation); if (!this.receipted(batch.meetingId,batch.role,item.processingKey)) break; cursor = row.id; }
    this.db.prepare('UPDATE processing_state SET cursor=?,pending=NULL WHERE meeting_id=? AND role=? AND processor=? AND generation=?').run(cursor,...this.namespace(batch.meetingId,batch.role,batch.processorRevision,batch.generation));
    return cursor;
  }
  commit(input: any, apply: (batch: Manifest, input: any) => { artifact: any; dispositions: { sourceId:number|null; recheckId?:number|null; processingKey:string; kind:string; payload?:any }[] }) {
    const batchId = text(input?.batchId, 64, 'BATCH_ID'); const batch = this.manifest(batchId); const payloadHash = contentHash({ outputs:input.outputs, skips:input.skips });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const saved: any = this.db.prepare('SELECT payload_hash,result FROM processing_commits WHERE batch_id=?').get(batchId);
      if (saved) {
        if (saved.payload_hash !== payloadHash) fail('PROCESSING_CONFLICT');
        this.db.exec('COMMIT'); return { ...JSON.parse(saved.result), duplicate:true };
      }
      const state = this.state(batch.meetingId,batch.role,batch.processorRevision,batch.generation);
      if (!state || state.owner !== input.ownerId || state.epoch !== input.epoch || state.lease_until <= this.now()) fail('STALE_PROCESSING_OWNER');
      if (state.pending !== batchId) fail('BATCH_NOT_PENDING');
      for (const item of batch.items) if (this.currentItem(batch.meetingId,item.ref,batch.processorRevision,batch.generation).ref.inputHash !== item.ref.inputHash) fail('STALE_PROCESSING_INPUT');
      const result = apply(batch,input);
      const dispositions = result.dispositions;
      if (dispositions.length !== batch.items.length || new Set(dispositions.map(x=>x.processingKey)).size !== batch.items.length) fail('INCOMPLETE_PROCESSING_BATCH');
      for (const item of batch.items) {
        const disposition = dispositions.find(x=>x.processingKey===item.processingKey); if (!disposition) fail('INCOMPLETE_PROCESSING_BATCH');
        const receipt = { sourceRef:item.ref,workKey:item.workKey,processingKey:item.processingKey,processorRevision:batch.processorRevision,generation:batch.generation,disposition,artifact:result.artifact };
        this.db.prepare('INSERT INTO processing_receipts VALUES(?,?,?,?,?,?,?,?)').run(batch.meetingId,batch.role,item.processingKey,item.ref.sourceId,item.ref.recheckId,batchId,canonical(receipt),new Date(this.now()).toISOString());
      }
      const cursor = this.advance(batch);
      this.db.prepare('INSERT INTO processing_projections(meeting_id,revision) VALUES(?,1) ON CONFLICT(meeting_id) DO UPDATE SET revision=revision+1').run(batch.meetingId);
      this.db.prepare("UPDATE processing_attempts SET state='committed' WHERE batch_id=?").run(batchId);
      const response = { saved:true, batchId, role:batch.role, processed:batch.items.length, cursor, artifact:result.artifact, rawProjection:'pending', duplicate:false };
      this.db.prepare('INSERT INTO processing_commits VALUES(?,?,?)').run(batchId,payloadHash,canonical(response));
      this.db.exec('COMMIT'); return response;
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  projection(id: string): any { return this.db.prepare('SELECT revision,completed_revision AS completedRevision,content_hash AS contentHash FROM processing_projections WHERE meeting_id=?').get(id) ?? {revision:0,completedRevision:0,contentHash:null}; }
  translationMeta(id: string, sourceId: number, currentText: string): any {
    const row:any=this.db.prepare("SELECT payload FROM processing_receipts WHERE meeting_id=? AND role='dich' AND source_id=? ORDER BY rowid DESC LIMIT 1").get(id,sourceId);
    const value=row ? JSON.parse(row.payload)?.disposition?.payload : null;
    return value?.text===currentText ? value : null;
  }
  rangeTranslation(id:string,recheckId:number):any {
    const row:any=this.db.prepare("SELECT payload FROM processing_receipts WHERE meeting_id=? AND role='dich' AND source_id IS NULL AND recheck_id=? ORDER BY rowid DESC LIMIT 1").get(id,recheckId);
    return row ? JSON.parse(row.payload).disposition : null;
  }
  projected(id: string, expectedRevision: number, hash: string) {
    return !!this.db.prepare('UPDATE processing_projections SET completed_revision=?,content_hash=? WHERE meeting_id=? AND revision=?').run(expectedRevision,hash,id,expectedRevision).changes;
  }
  attribution(id: string, sourceId: number, raw: any, expectedRevision: number, ownerConfirmation = false) {
    this.meeting(id); const {source} = this.source(id,sourceId);
    const actualChannel=String(source.boundary).includes('CHANNEL_MIC') ? 'mic' : 'speaker';
    if (raw?.channel!==actualChannel) fail('ATTRIBUTION_CHANNEL_MISMATCH');
    if (raw?.identityState==='channel_bound' && actualChannel!=='mic') fail('CHANNEL_BINDING_REQUIRES_CAPTURED_MIC');
    const prior: any = this.db.prepare('SELECT MAX(revision) AS revision FROM attribution_revisions WHERE meeting_id=? AND source_id=?').get(id,sourceId);
    if ((prior.revision ?? 0) !== expectedRevision) fail('STALE_ATTRIBUTION_REVISION');
    const value = attributionOf(raw,sourceId,Math.max(1,Math.round((source.end-source.start)*1000)),expectedRevision+1,ownerConfirmation);
    this.db.prepare('INSERT INTO attribution_revisions VALUES(?,?,?,?,?)').run(id,sourceId,expectedRevision+1,canonical(value),new Date(this.now()).toISOString());
    return { saved:true, attribution:value, correctionRoles:['dich','chinh'], sourceUnchanged:true };
  }
}
