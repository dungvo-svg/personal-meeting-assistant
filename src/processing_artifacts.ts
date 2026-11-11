import type { DatabaseSync } from 'node:sqlite';
import type { Manifest } from './processing.js';
import { isHallucination } from './text.js';
import { canonical } from './processing.js';

// Called ONLY inside ProcessingLedger.commit's SQLite transaction. No files or network.
export function applyProcessingArtifacts(db: DatabaseSync, batch: Manifest, data: any,
  pictureOf: (id:string)=>any, writePicture: (id:string,revision:number,text:string,sourceIds:number[],anchors:any[],recheckIds:number[])=>unknown) {
  const sourceIds = batch.items.map(x=>x.ref.sourceId).filter((id):id is number=>id!==null);
  const recheckIds=batch.items.filter(x=>x.ref.sourceId===null).map(x=>x.ref.recheckId!);
  const itemKey=(value:any):string=>value.sourceId===null ? 'range:'+value.recheckId : 'source:'+value.sourceId;
  const skipRows = data.skips ?? [];
  if (!Array.isArray(skipRows) || skipRows.length > 40) throw new Error('INVALID_PROCESSING_SKIPS');
  const skips = new Map<string,any>();
  for (const skip of skipRows) {
    const item=batch.items.find(x=>itemKey(x.ref)===itemKey(skip));
    if (!item || skips.has(itemKey(skip)) || !['pass_through_vi','ignored_hallucination','marked_unclear'].includes(skip.kind) || typeof skip.reason !== 'string' || !skip.reason.trim() || skip.reason.length>1000) throw new Error('INVALID_PROCESSING_SKIP');
    const source = item.source;
    if (skip.kind==='pass_through_vi' && source.language!=='vi') throw new Error('SKIP_REQUIRES_VI');
    if (skip.kind==='ignored_hallucination' && !isHallucination(source)) throw new Error('SKIP_REQUIRES_HALLUCINATION_EVIDENCE');
    skips.set(itemKey(skip),skip);
  }
  if (batch.role === 'dich') {
    const rows = data.outputs?.translations ?? [];
    if (!Array.isArray(rows) || rows.length>40) throw new Error('INVALID_PROCESSING_TRANSLATIONS');
    const translations = new Map<string,any>();
    for (const row of rows) {
      const source = batch.items.find(x=>itemKey(x.ref)===itemKey(row))?.source;
      if (!source || !['lo','th'].includes(source.language) || skips.has(itemKey(row)) || translations.has(itemKey(row)) || typeof row.text!=='string' || !row.text.trim() || row.text.length>2000) throw new Error('INVALID_PROCESSING_TRANSLATION');
      if (row.uncertainty && (!['none','unclear'].includes(row.uncertainty.state) || row.uncertainty.state==='unclear' && (typeof row.uncertainty.reason!=='string' || !row.uncertainty.reason.trim() || row.uncertainty.reason.length>1000))) throw new Error('INVALID_TRANSLATION_UNCERTAINTY');
      translations.set(itemKey(row),{text:row.text.trim(),uncertainty:row.uncertainty ?? {state:'none'}});
    }
    const dispositions = batch.items.map(item => {
      const row = translations.get(itemKey(item.ref)); const skip = skips.get(itemKey(item.ref));
      if (!row && !skip) throw new Error('INCOMPLETE_PROCESSING_BATCH');
      if(item.ref.sourceId!==null){
        if (row) db.prepare('INSERT OR REPLACE INTO translations VALUES(?,?,?,?)').run(item.ref.sourceId,batch.meetingId,row.text,new Date().toISOString());
        if (skip?.kind==='marked_unclear') db.prepare('INSERT OR REPLACE INTO translations VALUES(?,?,?,?)').run(item.ref.sourceId,batch.meetingId,'[chưa nghe rõ] '+skip.reason,new Date().toISOString());
        if (skip && skip.kind!=='marked_unclear') db.prepare('DELETE FROM translations WHERE source_id=? AND session_id=?').run(item.ref.sourceId,batch.meetingId);
      }
      return {sourceId:item.ref.sourceId,recheckId:item.ref.recheckId,processingKey:item.processingKey,kind:row?'translated':skip.kind,payload:row ?? skip};
    });
    return {artifact:{kind:'translations',sourceIds,recheckIds},dispositions};
  }
  const picture = data.outputs?.picture;
  if (!picture || typeof picture.text!=='string' || !picture.text.trim() || picture.text.length>8000 || !Number.isSafeInteger(picture.expectedPreviousRevision)) throw new Error('INVALID_PROCESSING_PICTURE');
  if (skips.size) throw new Error('SYNTHESIS_PICTURE_MUST_COVER_BATCH');
  const previous = pictureOf(batch.meetingId);
  if ((previous?.revision ?? 0)!==picture.expectedPreviousRevision) throw new Error('STALE_PICTURE_REVISION');
  const anchors = picture.anchors ?? [];
  if (!Array.isArray(anchors) || anchors.length>100) throw new Error('INVALID_PICTURE_ANCHORS');
  const keys = new Set<string>();
  for (const anchor of anchors) {
    if (!anchor || typeof anchor.key!=='string' || !/^[\w:.-]{1,120}$/.test(anchor.key) || keys.has(anchor.key) || typeof anchor.text!=='string' || !anchor.text.trim() || anchor.text.length>1000 || !['open','resolved','superseded','withdrawn'].includes(anchor.state) || !Array.isArray(anchor.sourceIds) || anchor.sourceIds.length>50 || anchor.recheckIds && (!Array.isArray(anchor.recheckIds)||anchor.recheckIds.length>50) || !anchor.sourceIds.length && !anchor.recheckIds?.length) throw new Error('INVALID_PICTURE_ANCHOR');
    keys.add(anchor.key);
    for (const id of anchor.sourceIds) if (!Number.isSafeInteger(id) || !db.prepare('SELECT 1 FROM sources WHERE session_id=? AND id=?').get(batch.meetingId,id)) throw new Error('SOURCE_OUTSIDE_SESSION');
    for(const id of anchor.recheckIds ?? []) if(!Number.isSafeInteger(id)||!db.prepare('SELECT 1 FROM rechecks WHERE session_id=? AND id=?').get(batch.meetingId,id)) throw new Error('RECHECK_OUTSIDE_SESSION');
    const old = previous?.anchors?.find((x:any)=>x.key===anchor.key);
    const provenanceChanged=old && canonical({sources:[...new Set(old.sourceIds)].sort(),rechecks:[...new Set(old.recheckIds ?? [])].sort()})!==canonical({sources:[...new Set(anchor.sourceIds)].sort(),rechecks:[...new Set(anchor.recheckIds ?? [])].sort()});
    if ((!old || old.text!==anchor.text || old.state!==anchor.state || provenanceChanged) && !anchor.sourceIds.some((id:number)=>sourceIds.includes(id)) && !(anchor.recheckIds ?? []).some((id:number)=>recheckIds.includes(id))) throw new Error('ANCHOR_CHANGE_NEEDS_CURRENT_SOURCE');
  }
  for (const old of previous?.anchors ?? []) if (!keys.has(old.key)) throw new Error('PICTURE_ANCHOR_DROPPED: '+old.key);
  const revision = picture.expectedPreviousRevision+1;
  writePicture(batch.meetingId,revision,picture.text,sourceIds,anchors,recheckIds);
  return {artifact:{kind:'picture',revision,sourceIds,recheckIds},dispositions:batch.items.map(x=>({sourceId:x.ref.sourceId,recheckId:x.ref.recheckId,processingKey:x.processingKey,kind:'pictured'}))};
}
