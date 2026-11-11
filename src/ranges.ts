// Time ranges cut into pieces for `pma recheck` (kept apart from cli.ts so tests can load it without running the CLI).
export const RECHECK_PIECE_SECONDS = 300;
// [from, to] in pieces of at most `seconds`, in the form they came in: HH:MM[:SS] local clock (past midnight it rolls on, as the
// host reads it) or ISO. An unreadable time goes through whole, for the host to refuse with its own message.
export function pieces(from: string, to: string, seconds: number): [string, string][] {
  const clockOf = (text: string) => { const m = text.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/); return m ? +m[1] * 3600 + +m[2] * 60 + +(m[3] ?? 0) : null; };
  const a = clockOf(from), b = clockOf(to);
  if (a !== null && b !== null) {
    if (a === b) return [[from, to]];
    const end = b > a ? b : b + 86400; const hms = (t: number) => { const d = ((t % 86400) + 86400) % 86400; return [Math.floor(d / 3600), Math.floor(d / 60) % 60, d % 60].map(n => String(n).padStart(2, '0')).join(':'); };
    const out: [string, string][] = []; for (let t = a; t < end; t += seconds) out.push([hms(t), hms(Math.min(end, t + seconds))]); return out.length ? out : [[from, to]];
  }
  const x = Date.parse(from), y = Date.parse(to);
  if (/^\d{4}-/.test(from) && /^\d{4}-/.test(to) && Number.isFinite(x) && Number.isFinite(y) && y > x) {
    const out: [string, string][] = []; for (let t = x; t < y; t += seconds * 1000) out.push([new Date(t).toISOString(), new Date(Math.min(y, t + seconds * 1000)).toISOString()]); return out;
  }
  return [[from, to]];
}
