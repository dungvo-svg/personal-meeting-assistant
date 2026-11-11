// Typed, local report evidence. Numeric legacy source IDs remain supported.
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import { ProcessingLedger, canonical } from './processing.js';

const positiveId = z.number().int().positive();
export const reportRefSchema = z.object({
  sourceId: positiveId.nullable().optional(), recheckId: positiveId.nullable().optional(),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  start: z.number().finite().nonnegative().optional(), end: z.number().finite().nonnegative().optional(),
  fromWall: z.string().max(40).nullable().optional(), toWall: z.string().max(40).nullable().optional(),
  captureId: z.string().max(150).optional(), timeBasis: z.enum(['capture_seconds', 'wall_clock']).optional(),
}).refine(r => r.sourceId != null || r.recheckId != null, 'A real sourceId or recheckId is required');
export const reportSourcesShape = { sourceIds: z.array(positiveId).max(200).optional(), sourceRefs: z.array(reportRefSchema).max(200).optional() };
export const reportTaskSchema = z.object({ task: z.string().min(1).max(2000), owner: z.string().max(200).optional(), due: z.string().max(200).optional(), ...reportSourcesShape, sourceIds: z.array(positiveId).max(50).optional(), sourceRefs: z.array(reportRefSchema).max(50).optional() });
export type ReportRefInput = z.infer<typeof reportRefSchema>;
export type ReportEvidence = { sourceId: number | null; recheckId: number | null; inputHash: string; start: number; end: number; fromWall: string | null; toWall: string | null; captureId: string; timeBasis: 'capture_seconds' | 'wall_clock'; text: string; language: string; origin: string; recheckChannel?: string; originalSourceWindow?: {start:number;end:number;wall:string;captureId:string} };

export function resolveReportSources(db: DatabaseSync, ledger: ProcessingLedger, meetingId: string, sourceIds: number[] = [], sourceRefs: ReportRefInput[] = []): ReportEvidence[] {
  if (!Array.isArray(sourceIds) || !Array.isArray(sourceRefs) || sourceIds.length + sourceRefs.length > 200 || !sourceIds.length && !sourceRefs.length) throw new Error('SOURCE_IDS_REQUIRED: numeric sourceIds or typed sourceRefs');
  const refs = [...sourceIds.map(sourceId => ({ sourceId })), ...sourceRefs];
  const resolved = refs.map(raw => {
    const parsed = reportRefSchema.safeParse(raw); if (!parsed.success) throw new Error('INVALID_REPORT_REFERENCE');
    const ref = parsed.data;
    const item = ledger.evidence(meetingId, ref);
    const s = item.source;
    const checkedRange=s.range ?? s.recheckRange;
    let fromWall: string | null = checkedRange?.fromWall ?? (s.wall || null);
    if (fromWall !== null && !Number.isFinite(Date.parse(fromWall))) throw new Error('INVALID_REPORT_TIME_RANGE');
    let toWall: string | null = checkedRange?.toWall ?? (fromWall ? new Date(Date.parse(fromWall) + (s.end - s.start) * 1000).toISOString() : null);
    const start = checkedRange ? 0 : Number(s.start), end = checkedRange ? (Date.parse(toWall!)-Date.parse(fromWall!))/1000 : Number(s.end);
    const captureId=checkedRange ? 'recheck:'+item.ref.recheckId : s.captureId;
    const timeBasis=checkedRange ? 'wall_clock' as const : 'capture_seconds' as const;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || checkedRange && end === start || (fromWall !== null && (!Number.isFinite(Date.parse(fromWall)) || !Number.isFinite(Date.parse(toWall!)) || Date.parse(toWall!) < Date.parse(fromWall)))) throw new Error('INVALID_REPORT_TIME_RANGE');
    if (ref.inputHash !== undefined && ref.inputHash !== item.ref.inputHash) throw new Error('STALE_REPORT_REFERENCE');
    if (ref.start !== undefined && ref.start !== start || ref.end !== undefined && ref.end !== end || ref.fromWall !== undefined && ref.fromWall !== fromWall || ref.toWall !== undefined && ref.toWall !== toWall || ref.captureId !== undefined && ref.captureId !== captureId || ref.timeBasis !== undefined && ref.timeBasis !== timeBasis) throw new Error('REPORT_TIME_OR_CAPTURE_MISMATCH');
    return { ...item.ref, start, end, fromWall, toWall, captureId, timeBasis, text: s.text, language: s.language, origin: s.origin,
      ...(s.recheckRange ? {recheckChannel:s.recheckRange.channel,originalSourceWindow:{start:s.start,end:s.end,wall:s.wall,captureId:s.captureId}} : {}) };
  });
  return [...new Map(resolved.map(ref => [canonical({sourceId:ref.sourceId,recheckId:ref.recheckId}), ref])).values()];
}

export const reportCitation = (ref: ReportEvidence) => ref.sourceId !== null
  ? `#${ref.sourceId}${ref.recheckId !== null ? ` (recheck:${ref.recheckId} [${ref.fromWall}–${ref.toWall}])` : ''}`
  : `recheck:${ref.recheckId} [${ref.fromWall}–${ref.toWall}]`;
