// The host's copy of the mic share rule (src/mic_share.ts) must answer exactly as tools/mic_state.py: the same cases go through both.
// Synthetic readings only; the Python side is the project's own .venv, run once with the cases on stdin (no audio, no model).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { shareOk, wholeOn, readerAlive } from '../dist/mic_share.js';

const T = 1_800_000_000;   // epoch seconds
const r = (dt, state, by = 'uia', more = {}) => ({ t: new Date((T + dt) * 1000).toISOString(), type: 'mic_state', state, app: 'zoom', by, ...more });
const beats = (from, to, state = 'on', step = 2) => { const out = []; for (let t = from; t <= to; t += step) out.push(r(t, state)); return out; };
const CASES = [
  ['on all through, beats every 2 s', beats(-4, 12), 0, 5],
  ['off for one reading inside', [...beats(-4, 2), r(3, 'off'), ...beats(4, 12)], 0, 5],
  ['unknown inside', [...beats(-4, 2), r(3, 'unknown'), ...beats(4, 12)], 0, 5],
  ['none (no app holds the mic)', beats(-4, 12, 'none'), 0, 5],
  ['no reading after the end', beats(-4, 4), 0, 5],
  ['no reading before the start', beats(2, 12), 0, 5],
  ['a gap over 4 s', [r(-2, 'on'), r(1, 'on'), r(7, 'on'), r(9, 'on')], 0, 5],
  ['manual on over automatic off', [...beats(-4, 12, 'off'), r(-1, 'on', 'manual')], 0, 5],
  ['manual off over automatic on', [...beats(-4, 12), r(-1, 'off', 'manual')], 0, 5],
  ['manual off then released', [...beats(-4, 12), r(-3, 'off', 'manual'), r(-2, 'unknown', 'manual', { release: true })], 0, 5],
  ['zero-length chunk', beats(-4, 12), 3, 3],
  ['no readings at all', [], 0, 5],
  ['unreadable entries ignored', [...beats(-4, 12), { t: 'not a time', type: 'mic_state', state: 'off' }, { type: 'mic_state', state: 'off' }], 0, 5],
];

test('mic share rule: the host and tools/mic_state.py give the same answers on the same cases', () => {
  const python = resolve('.venv/Scripts/python.exe');
  if (!existsSync(python)) return;   // no project Python here: the TS side alone is not compared
  const script = 'import json,sys\nsys.path.insert(0,"tools")\nimport mic_state as m\ncases=json.load(sys.stdin)\nprint(json.dumps([[m.whole_on(s,a,b),m.reader_alive(s,a,b),m.share_ok(s,a,b)] for _,s,a,b in cases]))';
  const cases = CASES.map(([name, states, a, b]) => [name, states, T + a, T + b]);
  const run = spawnSync(python, ['-I', '-c', script], { input: JSON.stringify(cases), encoding: 'utf8', cwd: resolve('.') });
  assert.equal(run.status, 0, run.stderr);
  const expected = JSON.parse(run.stdout);
  cases.forEach(([name, states, a, b], i) => assert.deepEqual([wholeOn(states, a, b), readerAlive(states, a, b), shareOk(states, a, b)], expected[i], name));
  assert.deepEqual(expected.map(e => e[2]), [true, false, false, false, false, false, false, false, false, true, true, false, true], 'and the answers are the ones the rule means');
});
