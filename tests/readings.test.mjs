// Item 1a: the two readings (Vietnamese and Lao) of a chunk travel with the row. Contract of a reading, its storage, `follow`/`read` lines, RAW,
// and the mic rule (a reading of a hidden row never leaves the host). Synthetic rows only: no audio, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { MeetingRuntime, parseAlternatives } from '../dist/runtime.js';
import { readingLines, readingFacts, hasReadings } from '../dist/text.js';

async function withRuntime(fn) {
  const directory = mkdtempSync(join(tmpdir(), 'personal-meeting-readings-'));
  const runtime = new MeetingRuntime(resolve('.'), directory, true); runtime.mixer = () => {};
  try { await fn(runtime, directory); } finally { await runtime.close(); assert.ok(resolve(directory).startsWith(resolve(tmpdir()))); rmSync(directory, { recursive: true }); }
}
const LONG = 'ສະບາຍດີ '.repeat(500);  // 4000 characters: the older cap (2000) would cut it
const reading = (language, more = {}) => ({ rv: 1, language, model: language === 'lo' ? 'buzzasr-lao-ct2' : 'whisper-large-v3-turbo-ct2', text: language === 'lo' ? 'ສະບາຍດີ 120,000 ຄົນ' : 'kho số hai còn đủ hàng',
  avgLogProb: language === 'lo' ? -0.431 : -0.812, score: language === 'lo' ? -0.431 : -0.812, viSyllableShare: language === 'lo' ? 0 : 1, viSyllables: language === 'lo' ? 0 : 7, viTokens: language === 'lo' ? 3 : 7,
  viSyllableVersion: 'vi-syl-rule-1', loopPenalty: 0, status: 'ok', picked: language === 'lo', ...more });

test('parseAlternatives keeps the whole contract of a reading and its full text; the older kind is unchanged', () => {
  const [lo, vi] = parseAlternatives([reading('lo', { text: LONG }), reading('vi')]);
  assert.equal(lo.text.length, LONG.trim().length, 'no longer cut at 2000 characters');
  assert.deepEqual({ ...lo, text: '' }, { ...reading('lo'), text: '' });
  assert.equal(vi.viSyllables, 7); assert.equal(vi.viTokens, 7); assert.equal(vi.viSyllableVersion, 'vi-syl-rule-1'); assert.equal(vi.picked, false);
  assert.deepEqual(parseAlternatives([{ language: 'th', text: 'สบายดี', score: -0.4 }, { language: 'xx', text: 'bỏ' }, { language: 'lo', text: '   ' }]), [{ language: 'th', text: 'สบายดี', score: -0.4 }]);
  assert.equal(parseAlternatives([{ language: 'th', text: 'x'.repeat(3000) }])[0].text.length, 2000, 'an older alternative keeps its 2000 cap');
  assert.equal(hasReadings(parseAlternatives([{ language: 'th', text: 'สบายดี' }])), false);
});

test('a reading with null scores (too short, no log-prob) and a made-up status stays honest: null stays null, status falls back to ok', () => {
  const [item] = parseAlternatives([reading('vi', { avgLogProb: null, score: undefined, viSyllableShare: null, status: 'strange', loopPenalty: 'x', picked: 'yes' })]);
  assert.equal(item.avgLogProb, null); assert.equal(item.viSyllableShare, null); assert.equal(item.status, 'ok'); assert.equal(item.loopPenalty, 0); assert.equal(item.picked, false);
  assert.equal(parseAlternatives([reading('vi', { status: 'empty', text: '' })]).length, 1, 'an empty reading is still a reading (it says the model heard nothing)');
});

test('readingLines: each reading is printed with its language and signals; the picked one is not repeated, the other carries its text', () => {
  const lines = readingLines(parseAlternatives([reading('lo'), reading('vi')]));
  assert.equal(lines.length, 2);
  assert.match(lines[0], /↳ lo \(dòng chính\) \[điểm mô hình -0\.431 \(buzzasr-lao-ct2\) · âm tiết Việt 0\/3 = 0% · lặp 0%\]$/);
  assert.match(lines[1], /↳ vi \(cách nghe song song\) \[điểm mô hình -0\.812 \(whisper-large-v3-turbo-ct2\) · âm tiết Việt 7\/7 = 100% · lặp 0%\]: kho số hai còn đủ hàng$/);
  assert.ok(!lines[0].includes('ສະບາຍດີ'), 'the picked reading is the row text: not printed twice');
  assert.match(readingFacts(reading('vi', { status: 'invented', viSyllableShare: null })), /âm tiết Việt n\/a · lặp 0% · nghi câu bịa/);
  assert.deepEqual(readingLines(parseAlternatives([{ language: 'th', text: 'สบายดี', score: -0.4 }])), ['  ↳ th (cách nghe khác): สบายดี']);
});

test('a row with readings is stored, read back, and written into RAW with both readings and the undecided mark', async () => {
  await withRuntime(async r => {
    r.prepare('Họp Việt Lào'); const id = r.session.id;
    const row = r.ingest('ສະບາຍດີ 120,000 ຄົນ', 'local_asr_unverified', 0, 9, 'READINGS_UNDECIDED; SOURCE_LIVE_FOLLOW', 'cap', 'lo', '', null, [reading('lo', { text: LONG }), reading('vi')]);
    const stored = r.sources(id).find(s => s.id === row).alternatives;
    assert.equal(stored.length, 2); assert.equal(stored[0].picked, true); assert.equal(stored[0].text.length, LONG.trim().length); assert.equal(stored[1].language, 'vi');
    const raw = readFileSync(r.writeRaw(id).path, 'utf8');
    assert.match(raw, /hai cách nghe \(Việt, Lào\) chưa phân định/);
    assert.match(raw, /↳ lo \(dòng chính\) \[điểm mô hình -0\.431/);
    assert.match(raw, /↳ vi \(cách nghe song song\) \[điểm mô hình -0\.812 \(whisper-large-v3-turbo-ct2\) · âm tiết Việt 7\/7 = 100% · lặp 0%\]: kho số hai/);
    assert.match(raw, /KHÔNG so sánh trực tiếp được/, 'the header says the model scores are not on one scale');
  });
});

test('mic OFF/UNKNOWN: every reading of the row stays inside the host, exactly like the text (OWN-030)', async () => {
  await withRuntime(async r => {
    r.prepare('Họp'); const id = r.session.id;
    const off = r.ingest('nói riêng chữ-riêng', 'local_asr_unverified', 0, 3, 'CHANNEL_MIC; MIC_STATE_OFF; SOURCE_LIVE_FOLLOW', 'cap', 'vi', '', null, [reading('lo', { text: 'ຄຳລັບ', picked: false }), reading('vi', { text: 'nói riêng chữ-riêng', picked: true })]);
    const unknown = r.ingest('chưa rõ chữ-lạ', 'local_asr_unverified', 3, 6, 'CHANNEL_MIC; MIC_STATE_UNKNOWN; SOURCE_LIVE_FOLLOW', 'cap', 'vi', '', null, [reading('lo', { text: 'ຄຳລັບ2', picked: false })]);
    const open = r.ingest('phòng họp', 'local_asr_unverified', 6, 9, 'SOURCE_LIVE_FOLLOW', 'cap', 'vi', '', null, [reading('lo', { text: 'ຄຳເປີດ', picked: false })]);
    for (const as of ['dich', 'khach']) {
      const read = r.read(id, 0, 100, as); const text = JSON.stringify(read);
      assert.deepEqual(read.items.map(i => i.id), [open], as);
      for (const secret of ['chữ-riêng', 'chữ-lạ', 'ຄຳລັບ', 'ຄຳລັບ2']) assert.ok(!text.includes(secret), `${as}: ${secret} did not leave the host`);
      assert.ok(read.items[0].alternatives.length === 1 && text.includes('ຄຳເປີດ'), 'a shareable row keeps its readings');
    }
    assert.deepEqual(r.read(id, 0, 100).items.map(i => i.id), [off, unknown, open], 'the owner sees all rows with their readings');
  });
});
