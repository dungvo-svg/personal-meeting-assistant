// The share rule for the owner's microphone, as tools/mic_state.py has it (whole_on, reader_alive, share_ok), for the host to check a
// mic row again right before it goes to a share role (0.12.1, ENG-44). The worker decides MIC_SHARE_OK once, when it transcribes;
// a mic reading written after that (a late OFF, the reader seen dead) must still stop the row. Same inputs, same answers as the
// Python functions (tests/mic_share.test.mjs checks both on the same cases). Times are epoch seconds or ISO strings.
type Entry = { t?: unknown; type?: unknown; state?: unknown; by?: unknown; release?: unknown };
const ON = 'MIC_STATE_ON', OFF = 'MIC_STATE_OFF', UNKNOWN = 'MIC_STATE_UNKNOWN';
const LABEL: Record<string, string> = { on: ON, off: OFF, none: OFF };

const epoch = (value: unknown) => typeof value === 'number' ? value : Date.parse(String(value).trim()) / 1000;

function readings(states: Entry[]): [number, Entry][] {
  const rows: [number, Entry][] = [];
  for (const entry of states ?? []) {
    if (!entry || typeof entry !== 'object' || (entry.type ?? 'mic_state') !== 'mic_state') continue;
    const at = epoch(entry.t); if (Number.isFinite(at)) rows.push([at, entry]);
  }
  return rows.sort((a, b) => a[0] - b[0]);
}

function effectiveSegments(states: Entry[], startWall: unknown, endWall: unknown): [number, number, string][] {
  const [begin, end] = [epoch(startWall), epoch(endWall)].sort((a, b) => a - b);
  let override: string | null = null; let auto = UNKNOWN;
  const apply = (entry: Entry) => {
    const label = LABEL[String(entry.state ?? '').toLowerCase()] ?? UNKNOWN;
    if (entry.by === 'manual') override = entry.release ? null : label; else auto = label;
  };
  const rows = readings(states); let index = 0;
  while (index < rows.length && rows[index][0] <= begin) apply(rows[index++][1]);
  let current = override ?? auto, since = begin; const segments: [number, number, string][] = [];
  for (const [moment, entry] of rows.slice(index)) {
    if (moment >= end) break;
    apply(entry); const changed = override ?? auto;
    if (changed !== current) { segments.push([since, moment, current]); since = moment; current = changed; }
  }
  segments.push([since, end, current]);
  return segments;
}

export const wholeOn = (states: Entry[], startWall: unknown, endWall: unknown) => effectiveSegments(states, startWall, endWall).every(([, , label]) => label === ON);

export function readerAlive(states: Entry[], startWall: unknown, endWall: unknown, maxGap = 4.0) {
  const [begin, end] = [epoch(startWall), epoch(endWall)].sort((a, b) => a - b);
  const seen = readings(states).filter(([, entry]) => entry.by !== 'manual').map(([moment]) => moment).filter(moment => begin - maxGap <= moment && moment <= end + maxGap);
  if (!seen.length || seen[0] > begin || seen.at(-1)! < end) return false;
  return seen.every((moment, i) => i === 0 || moment - seen[i - 1] <= maxGap);
}

export function shareOk(states: Entry[], startWall: unknown, endWall: unknown) {
  const automatic = (states ?? []).filter(entry => !(entry && typeof entry === 'object' && entry.by === 'manual'));
  return wholeOn(states, startWall, endWall) && wholeOn(automatic, startWall, endWall) && readerAlive(states, startWall, endWall);
}
