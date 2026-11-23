// Item 1b (0.13.3): the synthesis reads both readings. Coverage lists undecided rows for a recheck, `follow` does not hide the other reading of a
// row the ghost filter set aside, and the guide teaches how to read the two lines. Synthetic rows only: no audio, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { MeetingRuntime } from '../dist/runtime.js';

async function withRuntime(fn) {
  const directory = mkdtempSync(join(tmpdir(), 'personal-meeting-synthesis-'));
  const runtime = new MeetingRuntime(resolve('.'), directory, true); runtime.mixer = () => {};
  try { await fn(runtime, directory); } finally { await runtime.close(); rmSync(directory, { recursive: true }); }
}
const reading = (language, more = {}) => ({ rv: 1, language, model: language === 'lo' ? 'buzzasr-lao-ct2' : 'whisper-large-v3-turbo-ct2', text: language === 'lo' ? 'ສະບາຍດີ 120,000 ຄົນ' : 'kho số hai còn đủ hàng',
  avgLogProb: language === 'lo' ? -0.431 : -0.812, score: language === 'lo' ? -0.431 : -0.812, viSyllableShare: language === 'lo' ? 0 : 1, viSyllables: language === 'lo' ? 0 : 7, viTokens: language === 'lo' ? 3 : 7,
  viSyllableVersion: 'vi-syl-rule-1', loopPenalty: 0, status: 'ok', picked: language === 'lo', ...more });
const wall = k => new Date(Date.parse('2030-01-01T08:00:00Z') + k * 1000).toISOString();

test('coverage lists a row whose two readings were left undecided under UNSURE, and says why; a decided pair is not listed', async () => {
  await withRuntime(async r => {
    r.prepare('Họp Việt Lào'); const id = r.session.id;
    const undecided = r.ingest('ສະບາຍດີ 120,000 ຄົນ', 'local_asr_unverified', 0, 9, 'READINGS_UNDECIDED; SOURCE_LIVE_FOLLOW', 'cap', 'lo', wall(0), 1, [reading('lo'), reading('vi', { picked: false })]);
    r.ingest('kho số hai còn đủ hàng', 'local_asr_unverified', 9, 18, 'SOURCE_LIVE_FOLLOW', 'cap', 'vi', wall(9), 2, [reading('vi', { picked: true }), reading('lo', { picked: false })]);
    const unsure = r.coverage(id).items.filter(item => item.kind === 'UNSURE');
    assert.deepEqual(unsure.map(item => item.sourceId), [undecided]);
    assert.match(unsure[0].why, /hai cách nghe \(Việt, Lào\) chưa phân định/);
    assert.equal(unsure[0].recheck, `pma recheck #${undecided}`);
  });
});

test('a row the ghost filter set aside is still listed when its other reading has words; with nothing in the other reading it stays out', async () => {
  await withRuntime(async r => {
    r.prepare('Họp Việt Lào'); const id = r.session.id;
    const spared = r.ingest('Hãy subscribe cho kênh', 'local_asr_unverified', 0, 9, 'LIKELY_HALLUCINATION; READINGS_UNDECIDED; SOURCE_LIVE_FOLLOW', 'cap', 'vi', wall(0), 1, [reading('vi', { picked: true, text: 'Hãy subscribe cho kênh' }), reading('lo', { picked: false })]);
    r.ingest('Hãy subscribe cho kênh', 'local_asr_unverified', 9, 18, 'LIKELY_HALLUCINATION; READINGS_UNDECIDED; SOURCE_LIVE_FOLLOW', 'cap', 'vi', wall(9), 2, [reading('vi', { picked: true }), reading('lo', { picked: false, status: 'empty', text: '' })]);
    assert.deepEqual(r.coverage(id).items.filter(item => item.kind === 'UNSURE').map(item => item.sourceId), [spared]);
  });
});

test('the guide teaches the synthesis to read both readings: the labels, the scale, the 100% trap, the undecided rule, [chưa nghe rõ], and both Lao examples', () => {
  const guide = readFileSync(resolve('guide/hop.md'), 'utf8');
  for (const needle of ['↳ lo (cách nghe song song)', '↳ vi (cách nghe song song)', '(dòng chính)', 'không cùng thang', 'viSyllableShare', '100%', 'chưa phân định', '[chưa nghe rõ]', 'La kha Vê nừng', 'ລາຄາ P1', 'Hàn khải nhốt', 'ຮ້ານຂາຍຍ່ອຍ'])
    assert.ok(guide.includes(needle), 'guide/hop.md mentions: ' + needle);
});
