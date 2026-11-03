// What a host can do, as its ping says (0.12.1). A capability names one contract and its number changes when that contract changes, so a
// client can tell an older host (0.11 answers ping with no capabilities) from one that enforces the draft guards: the version string
// is not enough, several WIP builds share it. It is what the host SAYS over the local token: it keeps a draft from reaching an old host
// that does not know the contract; it is not an authentication against a host that lies.
//   draft-guard/1      drafts are checked against pma-draft/1, base revision required, idempotency key honoured, picture key reserved
//   context-receipt/1  brief --as <role> issues rcpt-…; the central drafts need it
//   job-token/1        job start returns a token; job done/fail need it
//   mic-session/1      an explicit mic choice is kept by the session
export const PROTOCOL = 'pma-rpc/2';
export const CAPABILITIES = ['draft-guard/1', 'context-receipt/1', 'job-token/1', 'mic-session/1'] as const;
// What attach() needs before it sends a draft; a job result also needs the job token.
export const DRAFT_NEEDS: readonly string[] = ['draft-guard/1', 'context-receipt/1'];
export const needsFor = (method: string): readonly string[] => method === 'job' ? [...DRAFT_NEEDS, 'job-token/1'] : DRAFT_NEEDS;
// The note key the meeting picture is stored under: only `pma picture` (receipt, base) writes it. An older host does not reserve it, so
// the client refuses it before any host is asked (a note under it would be a picture revision past the new guards).
export const PICTURE_KEY = 'buc-tranh';
// Requests sent through call() (not attach) that rely on a guarantee only a newer host gives. Everything else (status, read, finish,
// shutdown, follow, notes under other keys ...) is not gated: an older host keeps serving it, and an explicit stop always reaches it.
//   prepare with mic:false  an 0.11 prepare does not know `mic` and would record the microphone anyway
export function callNeeds(method: string, args: any): readonly string[] {
  if (method === 'prepare' && args?.mic === false) return ['mic-session/1'];
  return [];
}
export const missingFrom = (pong: any, needs: readonly string[]) => { const have: unknown[] = Array.isArray(pong?.capabilities) ? pong.capabilities : []; return needs.filter(n => !have.includes(n)); };
