// Pre-meeting context (participants, brief, owner) and the owner's microphone label/state. Fake data only; no audio.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { MeetingRuntime } from '../dist/runtime.js';
import { applyParticipants, canonicalOwner, parseParticipants } from '../dist/participants.js';
import { buildBrief, composeBrief, BRIEF_MAX_BYTES } from '../dist/brief.js';
import { loadOwner } from '../dist/owner.js';
import { micLabel } from '../dist/text.js';
import { setMicState } from '../dist/mic.js';

async function withRuntime(fn) {
  const directory = mkdtempSync(join(tmpdir(), 'personal-meeting-context-'));
  const runtime = new MeetingRuntime(resolve('.'), directory, true); runtime.mixer = () => {};
  try { await fn(runtime, directory); } finally { await runtime.close(); rmSync(directory, { recursive: true }); }
}
const bytes = text => Buffer.byteLength(text, 'utf8');

test('participants are stored in the session context and their variants reach the glossary; risky variants are skipped and reported', async () => {
  await withRuntime(async r => {
    r.prepare('Họp thử', false, 'Chốt giá Q4', ['vi', 'lo']);
    const report = applyParticipants(r, [
      { name: 'Namfon', role: 'Giám đốc kho', languages: ['lo'], variants: ['Nam Phủ', 'Ta', 'Nam Phun'] },
      { name: 'Oanh', languages: ['vi', 'th'], variants: ['phim'] },
      { name: 'Khamla' },
    ]);
    assert.equal(report.participants, 3);
    assert.equal(report.glossaryVariantsAdded, 2);
    assert.deepEqual(report.skippedVariants.map(s => [s.name, s.variant, s.why]), [['Namfon', 'Ta', 'quá ngắn'], ['Oanh', 'phim', 'là từ thông dụng']]);
    assert.deepEqual(r.glossary.find(e => e.name === 'Namfon').variants, ['Nam Phủ', 'Nam Phun']);
    assert.equal(r.glossary.find(e => e.name === 'Oanh'), undefined);
    assert.equal(r.shown('anh Nam Phủ nói'), 'anh Namfon (nghe: Nam Phủ) nói');
    assert.equal(r.session.context.participants.length, 3);
    // Persisted: a fresh read of the row has them, and a second call replaces the list.
    assert.equal(JSON.parse(r.db.prepare('SELECT context FROM sessions WHERE id=?').get(r.session.id).context).participants[0].role, 'Giám đốc kho');
    applyParticipants(r, [{ name: 'Namfon' }]);
    assert.deepEqual(r.session.context.participants.map(p => p.name), ['Namfon']);
  });
});

test('participants input is validated; no session means no participants', async () => {
  assert.throws(() => parseParticipants({}), /INVALID_PARTICIPANTS/);
  assert.throws(() => parseParticipants([{ role: 'x' }]), /thiếu name/);
  assert.throws(() => parseParticipants([{ name: 'A', languages: ['en'] }]), /languages chỉ gồm vi, lo, th/);
  assert.throws(() => parseParticipants(Array.from({ length: 51 }, (_, i) => ({ name: 'P' + i }))), /tối đa 50/);
  assert.deepEqual(parseParticipants([{ name: 'Namfon', variants: ['Nam Phủ'] }, { name: 'namfon', role: 'Kho', variants: ['Nam Phun'] }]), [{ name: 'Namfon', role: 'Kho', languages: undefined, variants: ['Nam Phủ', 'Nam Phun'] }]);
  await withRuntime(async r => { assert.throws(() => applyParticipants(r, [{ name: 'A' }]), /SESSION_NOT_ACTIVE/); });
});

test('task owners spelt like a participant variant become the participant name; anything else is left alone', async () => {
  assert.equal(canonicalOwner([{ name: 'Namfon', variants: ['Nam Phủ'] }], 'nam  phủ'), 'Namfon');
  assert.equal(canonicalOwner([{ name: 'Namfon', variants: ['Nam Phủ'] }], 'Namfon (nghe: Nam Phủ)'), 'Namfon');
  assert.equal(canonicalOwner([{ name: 'Namfon', variants: ['Nam Phủ'] }], 'Oanh'), 'Oanh');
  assert.equal(canonicalOwner(undefined, 'Oanh'), 'Oanh');
  assert.equal(canonicalOwner([{ name: 'Namfon' }], undefined), undefined);
  await withRuntime(async r => {
    r.prepare('Họp', false, undefined, ['vi']); const id = r.session.id;
    applyParticipants(r, [{ name: 'Namfon', variants: ['Nam Phủ'] }]);
    const a = r.ingest('Nam Phủ kiểm kho', 'local_asr_unverified', 0, 3, 'X', 'cap', 'vi');
    await r.finish(id);
    const tasks = readFileSync(r.saveTasks(id, [{ task: 'Kiểm kho', owner: 'Nam Phủ', sourceIds: [a] }, { task: 'Gửi giá', owner: 'Oanh', sourceIds: [a] }]).path, 'utf8');
    assert.match(tasks, /\| Kiểm kho \| Namfon \|/);
    assert.match(tasks, /\| Gửi giá \| Oanh \|/);
  });
});

test('brief: who I am, meeting, participants, terms, one status line, at most 2 KB, read-only', async () => {
  await withRuntime(async (r, directory) => {
    const root = join(directory, 'root'); mkdirSync(join(root, '.local', 'context'), { recursive: true });
    writeFileSync(join(root, '.local', 'context', 'owner.json'), JSON.stringify({ name: 'Nguyễn Văn An', role: 'Trưởng phòng Kinh doanh', company: 'Công ty ABC', languages: ['vi', 'lo'], addressedAs: ['anh An'] }));
    r.prepare('Họp mua hàng Q4', false, 'Chốt giá vitamin C\n\nDuyệt đơn nhập tháng 11', ['vi', 'lo'], { at: '13:30' });
    applyParticipants(r, [{ name: 'Namfon', role: 'Giám đốc kho', languages: ['lo'], variants: ['Nam Phủ'] }, { name: 'Oanh', role: 'Kế toán', languages: ['vi'] }]);
    r.glossaryAdd('MISA', ['mì da']);
    const before = JSON.stringify(r.session.context);
    const brief = composeBrief(r, root);
    assert.equal(JSON.stringify(r.session.context), before);
    assert.match(brief, /\*\*Tôi:\*\* Nguyễn Văn An · Trưởng phòng Kinh doanh · Công ty ABC · nói vi, lo · mọi người gọi: anh An/);
    assert.match(brief, /\*\*Họp:\*\* Họp mua hàng Q4 · lịch 13:30 · ngôn ngữ vi\/lo/);
    assert.match(brief, /Chốt giá vitamin C Duyệt đơn nhập tháng 11/);
    assert.match(brief, /\*\*Người dự \(2\):\*\*\n- Namfon — Giám đốc kho · lo\n- Oanh — Kế toán · vi/);
    assert.match(brief, /Namfon \(hay nghe: Nam Phủ\); MISA \(hay nghe: mì da\)/);
    const lines = brief.trimEnd().split('\n');
    assert.match(lines.at(-1), /^\*\*Tình trạng:\*\* (không nghe|đang nạp mô hình|sẵn sàng nghe|chờ nguồn tiếng|đang nghe) · chưa đọc 0 đoạn · không lỗi$/);
    assert.equal(lines.filter(l => l.startsWith('**Tình trạng:**')).length, 1);
    assert.ok(bytes(brief) <= BRIEF_MAX_BYTES);
  });
});

test('brief stays within 2 KB (bytes) with a long agenda, 50 participants and hundreds of terms, and keeps the status line', async () => {
  const people = Array.from({ length: 50 }, (_, i) => ({ name: `Người dự số ${i} Nguyễn`, role: 'Trưởng phòng kinh doanh khu vực', languages: ['vi', 'lo', 'th'] }));
  const glossary = Array.from({ length: 400 }, (_, i) => ({ name: `Tên thuật ngữ dài ${i}`, variants: ['nghe sai một', 'nghe sai hai', 'nghe sai ba'] }));
  const brief = buildBrief({
    owner: { name: 'Nguyễn Văn An', role: 'Trưởng phòng Kinh doanh', company: 'Công ty ABC', languages: ['vi', 'lo'], addressedAs: ['anh An', 'An', 'chú An'] },
    session: { title: 'Họp '.repeat(70), ended: null, languages: ['vi', 'lo'], context: { agenda: 'Nội dung chương trình rất dài. '.repeat(400), participants: people, meeting: { platform: 'meet', meetingId: 'abc-defg-hij' }, scheduledStart: '2026-10-31T06:30:00.000Z' } },
    glossary, captureState: 'LISTENING', unread: 12, lastError: 'Lỗi rất dài '.repeat(100), minutesRecorded: 47,
  });
  assert.ok(bytes(brief) <= BRIEF_MAX_BYTES, `brief is ${bytes(brief)} bytes`);
  const last = brief.trimEnd().split('\n').at(-1);
  assert.match(last, /^\*\*Tình trạng:\*\* đang nghe · đã ghi 47 phút · chưa đọc 12 đoạn · lỗi cuối: /);
  assert.match(brief, /Google Meet abc-defg-hij/);
  assert.match(brief, /và \d+ người nữa/);
});

test('brief without owner file or session says so, and an ended session says ended', async () => {
  await withRuntime(async (r, directory) => {
    const root = join(directory, 'empty'); mkdirSync(root);
    assert.equal(loadOwner(root), null);
    const none = composeBrief(r, root);
    assert.match(none, /\*\*Tôi:\*\* chưa biết/); assert.match(none, /chưa có phiên họp/); assert.match(none, /\*\*Tình trạng:\*\* chưa có phiên\n$/);
    r.prepare('Họp xong', false, undefined, ['vi'], { me: 'Dũng' }); const id = r.session.id; await r.finish(id);
    const done = composeBrief(r, root);
    assert.match(done, /\*\*Tôi:\*\* Dũng/); assert.match(done, /\*\*Tình trạng:\*\* phiên đã kết thúc/);
    assert.match(composeBrief(r, root, id), /phiên đã kết thúc/);
    assert.throws(() => composeBrief(r, root, '00000000-0000-4000-8000-000000000000'), /SESSION_NOT_FOUND/);
  });
});

test('owner file: the example parses, a broken file is no owner', async () => {
  const example = JSON.parse(readFileSync('config/owner.example.json', 'utf8'));
  assert.ok(example.name && example.role && !JSON.stringify(example).match(/password|token|secret|key/i));
  await withRuntime(async (r, directory) => {
    mkdirSync(join(directory, '.local', 'context'), { recursive: true });
    writeFileSync(join(directory, '.local', 'context', 'owner.json'), '{not json');
    assert.equal(loadOwner(directory), null);
    writeFileSync(join(directory, '.local', 'context', 'owner.json'), JSON.stringify({ ...example, languages: 'vi', extra: 1 }));
    assert.deepEqual(loadOwner(directory), { name: example.name, role: example.role, company: example.company, languages: undefined, addressedAs: example.addressedAs });
  });
});

test('display labels follow the microphone flags; without a flag it stays "Tôi (micro)"', () => {
  assert.equal(micLabel('SILENCE; CHANNEL_MIC; MIC_STATE_ON'), 'Tôi (mic bật)');
  assert.equal(micLabel('CHANNEL_MIC; MIC_STATE_OFF'), 'Tôi (mic tắt — nói riêng)');
  assert.equal(micLabel('CHANNEL_MIC; MIC_STATE_UNKNOWN'), 'Tôi (?)');
  assert.equal(micLabel('CHANNEL_MIC'), 'Tôi (micro)');
  assert.equal(micLabel('CHANNEL_MIC; MIC_STATE_ON', 'Dũng'), 'Tôi — Dũng (mic bật)');
  assert.equal(micLabel('SILENCE_BOUNDARY_HEURISTIC'), null);
  assert.equal(micLabel(undefined), null);
});

test('RAW labels the owner channel by microphone state', async () => {
  await withRuntime(async r => {
    r.prepare('Họp', false, undefined, ['vi'], { me: 'Dũng' }); const id = r.session.id;
    const on = r.ingest('Em gửi bảng giá', 'local_asr_unverified', 0, 3, 'CHANNEL_MIC; MIC_STATE_ON', 'cap', 'vi');
    const off = r.ingest('Cho anh ly cà phê', 'local_asr_unverified', 3, 6, 'CHANNEL_MIC; MIC_STATE_OFF', 'cap', 'vi');
    const unknown = r.ingest('Ừ để anh xem', 'local_asr_unverified', 6, 9, 'CHANNEL_MIC; MIC_STATE_UNKNOWN', 'cap', 'vi');
    const plain = r.ingest('Dạ vâng', 'local_asr_unverified', 9, 12, 'CHANNEL_MIC', 'cap', 'vi');
    const raw = readFileSync(r.writeRaw(id).path, 'utf8');
    assert.ok(raw.includes(`#${on} (nghe · vi · Tôi — Dũng (mic bật)) Em gửi bảng giá`));
    assert.ok(raw.includes(`#${off} (nghe · vi · Tôi — Dũng (mic tắt — nói riêng)) Cho anh ly cà phê`));
    assert.ok(raw.includes(`#${unknown} (nghe · vi · Tôi — Dũng (?)) Ừ để anh xem`));
    assert.ok(raw.includes(`#${plain} (nghe · vi · Tôi — Dũng (micro)) Dạ vâng`));
  });
});

test('pma me writes a manual mic_state entry into the session timeline (on, off, auto)', async () => {
  await withRuntime(async (r, directory) => {
    assert.throws(() => setMicState(r, 'on'), /SESSION_NOT_ACTIVE/);
    r.prepare('Họp', false, undefined, ['vi']);
    assert.throws(() => setMicState(r, 'maybe'), /INVALID_MIC_STATE/);
    const first = setMicState(r, 'on', new Date('2026-10-31T06:30:00.000Z'));
    setMicState(r, 'off', new Date('2026-10-31T06:31:00.000Z'));
    setMicState(r, 'auto', new Date('2026-10-31T06:32:00.000Z'));
    assert.equal(first.path, join(directory, 'audio', r.session.id, 'timeline.jsonl'));
    assert.ok(existsSync(first.path));
    const rows = readFileSync(first.path, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(rows[0], { t: '2026-10-31T06:30:00.000Z', type: 'mic_state', state: 'on', app: 'none', by: 'manual' });
    assert.deepEqual(rows[1], { t: '2026-10-31T06:31:00.000Z', type: 'mic_state', state: 'off', app: 'none', by: 'manual' });
    assert.deepEqual(rows[2], { t: '2026-10-31T06:32:00.000Z', type: 'mic_state', state: 'unknown', app: 'none', by: 'manual', release: true });
  });
});
