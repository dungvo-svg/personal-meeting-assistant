// Item 8 (0.13.3): the name table by meeting context. Synthetic names only; no audio, no ASR, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { MeetingRuntime } from '../dist/runtime.js';
import { applyParticipants, canonicalOwner, parseParticipants } from '../dist/participants.js';
import { applyWeakNames, hotwordsOf, historyNames, nameTable, weakNameRules, HOTWORDS_MAX_CHARS, HOTWORDS_MAX_TERMS } from '../dist/names.js';
import { buildBrief } from '../dist/brief.js';
import { validateDraft } from '../dist/drafts.js';
import { audioDir } from '../dist/audio.js';

async function withRuntime(fn) {
  const directory = mkdtempSync(join(tmpdir(), 'personal-meeting-names-'));
  const runtime = new MeetingRuntime(resolve('.'), directory, true); runtime.mixer = () => {};
  try { await fn(runtime, directory); } finally { await runtime.close(); rmSync(directory, { recursive: true }); }
}
const TABLE = [
  { name: 'Hạnh', kind: 'attendee', weakVariants: ['hành'] },
  { name: 'Khamla', kind: 'mentioned' },
  { name: 'Bao', kind: 'alias', of: 'Khamla' },
];

test('kinds: attendee is the default; mentioned, alias and system are kept; an alias needs the person it stands for; a wrong kind is refused', () => {
  const parsed = parseParticipants([{ name: 'Namfon' }, { name: 'Khamla', kind: 'mentioned', role: 'giám đốc chi nhánh' }, { name: 'Bao', kind: 'alias', of: 'Khamla' }, { name: 'Acme', kind: 'system', variants: ['ách mi'] }, { name: 'Hạnh', weakVariants: ['hành', 'hành'] }]);
  assert.deepEqual(parsed.map(p => [p.name, p.kind]), [['Namfon', undefined], ['Khamla', 'mentioned'], ['Bao', 'alias'], ['Acme', 'system'], ['Hạnh', undefined]]);
  assert.equal(parsed[2].of, 'Khamla');
  assert.deepEqual(parsed[4].weakVariants, ['hành']);
  assert.throws(() => parseParticipants([{ name: 'Bao', kind: 'alias' }]), /alias.*of/);
  assert.throws(() => parseParticipants([{ name: 'X', kind: 'boss' }]), /kind chỉ gồm/);
  assert.throws(() => parseParticipants([{ name: 'X', weakVariants: 'hành' }]), /weakVariants phải là danh sách/);
});

test('the draft validator lets the new fields through and still refuses unknown keys and kinds', () => {
  const ok = validateDraft('participants', { participants: [{ name: 'Khamla', kind: 'mentioned' }, { name: 'Bao', kind: 'alias', of: 'Khamla' }, { name: 'Hạnh', weakVariants: ['hành'] }] });
  assert.equal(ok.ok, true);
  assert.equal(validateDraft('participants', { participants: [{ name: 'X', kind: 'boss' }] }).ok, false);
  assert.equal(validateDraft('participants', { participants: [{ name: 'X', role2: 'y' }] }).ok, false);
});

test('applyParticipants: attendees stay the roster, the rest is the name table; a nickname never rewrites the text; variants of the others reach the glossary', async () => {
  await withRuntime(async r => {
    r.prepare('Họp thử', false, 'Chốt giá', ['vi', 'lo']);
    const report = applyParticipants(r, [
      { name: 'Namfon', variants: ['Nam Phủ'] },
      { name: 'Khamla', kind: 'mentioned', variants: ['Khăm la'] },
      { name: 'Acme', kind: 'system', variants: ['ách mi'] },
      { name: 'Bao', kind: 'alias', of: 'Khamla', variants: ['Bao Bao'] },
    ]);
    assert.equal(report.participants, 1); assert.equal(report.names, 3);
    assert.deepEqual(r.session.context.participants.map(p => p.name), ['Namfon']);
    assert.deepEqual(r.session.context.names.map(p => [p.name, p.kind]), [['Khamla', 'mentioned'], ['Acme', 'system'], ['Bao', 'alias']]);
    assert.equal(r.shown('anh Khăm la hỏi về ách mi'), 'anh Khamla (nghe: Khăm la) hỏi về Acme (nghe: ách mi)');
    assert.equal(r.shown('Bao Bao nói'), 'Bao Bao nói', 'an alias is not rewritten');
    assert.equal(r.glossary.find(e => e.name === 'Bao'), undefined);
    // The persisted context has both lists, and a second call replaces both.
    const stored = JSON.parse(r.db.prepare('SELECT context FROM sessions WHERE id=?').get(r.session.id).context);
    assert.equal(stored.names.length, 3);
    applyParticipants(r, [{ name: 'Namfon' }]);
    assert.deepEqual(r.session.context.names, []);
  });
});

test('a task owner given as a nickname becomes the person it stands for (and a flagged correction is still read as the name)', () => {
  const names = [{ name: 'Bao', kind: 'alias', of: 'Khamla' }];
  assert.equal(canonicalOwner([], 'Bao', names), 'Khamla');
  assert.equal(canonicalOwner([{ name: 'Hạnh' }], 'Hạnh (nghe: hành) (sửa theo bảng tên)'), 'Hạnh');
  assert.equal(canonicalOwner([{ name: 'Hạnh' }], 'Hạnh (nghe: hành)'), 'Hạnh');
  assert.equal(canonicalOwner([{ name: 'Hạnh' }], 'Ai đó', names), 'Ai đó');
});

test('weak variants: corrected only where an assignment verb follows, marked, and never where the word is the ordinary one', () => {
  const rules = weakNameRules(TABLE);
  assert.deepEqual(rules, [{ name: 'Hạnh', variant: 'hành' }]);
  const flag = '(sửa theo bảng tên)';
  assert.equal(applyWeakNames('hành nghiên cứu phương án giá', rules), `Hạnh (nghe: hành) ${flag} nghiên cứu phương án giá`);
  assert.equal(applyWeakNames('Việc này Hành phụ trách, hạn thứ Sáu', rules), `Việc này Hạnh (nghe: Hành) ${flag} phụ trách, hạn thứ Sáu`);
  // Ordinary uses stay exactly as heard.
  for (const text of ['ăn hành phi rất ngon', 'hành tây giá 12.000', 'không hành nghiên cứu', 'để hành kiểm tra', 'cần hành gửi', 'hành động nghiên cứu', 'hành']) assert.equal(applyWeakNames(text, rules), text, text);
  // Not corrected twice, and nothing to do without rules.
  const once = applyWeakNames('hành gửi báo giá', rules);
  assert.equal(applyWeakNames(once, rules), once);
  assert.equal(applyWeakNames('hành gửi báo giá', []), 'hành gửi báo giá');
});

test('the runtime shows the flag only for a context-based correction; an ordinary glossary variant keeps the plain "(nghe: …)" form', async () => {
  await withRuntime(async r => {
    r.prepare('Họp thử', false, 'Chốt giá', ['vi']);
    applyParticipants(r, [{ name: 'Hạnh', variants: ['Hanh Hanh'], weakVariants: ['hành'] }]);
    assert.equal(r.shown('hành nghiên cứu giá, Hanh Hanh gửi'), 'Hạnh (nghe: hành) (sửa theo bảng tên) nghiên cứu giá, Hạnh (nghe: Hanh Hanh) gửi');
    assert.equal(r.shown('ăn hành'), 'ăn hành');
    // Stored text is never touched: the row keeps what was heard; `shown` is what Claude reads.
    const id = r.ingest('hành nghiên cứu giá', 'local_asr_unverified', 0, 3, 'SOURCE_LIVE_FOLLOW', 'cap', 'vi');
    const row = r.sources(r.session.id).find(s => s.id === id);
    assert.equal(row.text, 'hành nghiên cứu giá'); assert.match(row.shown, /^Hạnh \(nghe: hành\) \(sửa theo bảng tên\) nghiên cứu giá$/);
    const raw = readFileSync(r.writeRaw(r.session.id).path, 'utf8');
    assert.match(raw, /Hạnh \(nghe: hành\) \(sửa theo bảng tên\) nghiên cứu giá/);
  });
});

test('hotwords: Vietnamese gets every name; Lao gets only names in Lao script; too-short nicknames and the over-long list are left out', () => {
  const table = nameTable({ participants: [{ name: 'Namfon' }], names: [{ name: 'Acme', kind: 'system' }, { name: 'Ta', kind: 'alias', of: 'Namfon' }, { name: 'ຄຳຟອນ', kind: 'mentioned' }, { name: 'Khamla', kind: 'mentioned' }] }, [{ name: 'Glossa', variants: [] }, { name: 'namfon', variants: [] }]);
  assert.deepEqual(table.map(t => [t.name, t.source]), [['Acme', 'context'], ['Namfon', 'context'], ['ຄຳຟອນ', 'context'], ['Khamla', 'context'], ['Ta', 'context'], ['Glossa', 'glossary']]);
  const { vi, lo } = hotwordsOf(table);
  assert.deepEqual(vi, ['Acme', 'Namfon', 'Khamla', 'Glossa']);
  assert.deepEqual(lo, ['ຄຳຟອນ']);
  const many = hotwordsOf(Array.from({ length: 80 }, (_, i) => ({ name: 'Tên-dài-số-' + i, kind: 'attendee', source: 'context' })));
  assert.ok(many.vi.length <= HOTWORDS_MAX_TERMS && many.vi.join(', ').length <= HOTWORDS_MAX_CHARS);
});

test('names met in earlier meetings: most frequent first, this meeting and nicknames left out', async () => {
  await withRuntime(async r => {
    const insert = (id, created, context) => r.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run(id, 'cũ', created, null, 'asr', JSON.stringify(context));
    insert('s1', '2030-01-01T00:00:00Z', { participants: [{ name: 'Namfon' }, { name: 'Oanh' }], names: [{ name: 'Acme', kind: 'system' }, { name: 'Bao', kind: 'alias', of: 'Oanh' }] });
    insert('s2', '2030-01-02T00:00:00Z', { participants: [{ name: 'namfon' }], names: [{ name: 'Khamla', kind: 'mentioned' }] });
    insert('s3', '2030-01-03T00:00:00Z', { participants: [{ name: 'Chỉ-buổi-này' }] });
    insert('bad', '2030-01-04T00:00:00Z', 'not an object');
    const found = historyNames(r.db, 's3');
    assert.deepEqual(found.map(f => f.name), ['namfon', 'Acme', 'Khamla', 'Oanh']);
    assert.ok(!found.some(f => f.name === 'Bao' || f.name === 'Chỉ-buổi-này'));
    assert.ok(found.every(f => f.source === 'history'));
  });
});

test('the host writes hotwords.json next to the recorder files: from the context, the glossary and earlier meetings; a glossary change updates it; nothing outside the data folder is written', async () => {
  await withRuntime(async (r, directory) => {
    r.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run('old', 'cũ', '2030-01-01T00:00:00Z', null, 'asr', JSON.stringify({ participants: [{ name: 'Oanh' }] }));
    r.prepare('Họp thử', false, 'Chốt giá', ['vi', 'lo'], { hotwords: true });
    const id = r.session.id;
    const report = applyParticipants(r, [{ name: 'Namfon' }, { name: 'Acme', kind: 'system' }, { name: 'ຄຳຟອນ', kind: 'mentioned' }]);
    assert.deepEqual(report.hotwords, { vi: 3, lo: 1 });
    const file = join(audioDir(directory, id), 'hotwords.json');
    assert.ok(existsSync(file));
    let body = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(body.terms.vi, ['Acme', 'Namfon', 'Oanh'], 'system, attendee, then the earlier meeting; the Lao-script name is not in the Vietnamese prompt');
    assert.equal(body.vi, 'Acme, Namfon, Oanh');
    assert.deepEqual(body.terms.lo, ['ຄຳຟອນ']);
    r.glossaryAdd('Zeta', ['zê ta']);
    body = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(body.terms.vi.includes('Zeta'));
    r.glossaryRemove('Zeta');
    assert.ok(!JSON.parse(readFileSync(file, 'utf8')).terms.vi.includes('Zeta'));
  });
});

test('hotwords are OFF by default (offline A/B 23/11 found invented names): the file is written empty, and a meeting started with hotwords turns them on', async () => {
  await withRuntime(async (r, directory) => {
    r.prepare('Họp thử', false, 'Chốt giá', ['vi', 'lo']);
    const id = r.session.id;
    const report = applyParticipants(r, [{ name: 'Namfon' }, { name: 'Acme', kind: 'system' }]);
    assert.deepEqual(report.hotwords, { vi: 0, lo: 0 });
    const body = JSON.parse(readFileSync(join(audioDir(directory, id), 'hotwords.json'), 'utf8'));
    assert.equal(body.vi, ''); assert.equal(body.lo, '');
    assert.equal(r.session.context.hotwords, undefined);
  });
  await withRuntime(async r => {
    r.prepare('Họp thử', false, 'Chốt giá', ['vi'], { hotwords: true });
    assert.equal(r.session.context.hotwords, true);
  });
});

test('the brief lists the people mentioned, the nicknames and the system names apart from the attendees', () => {
  const text = buildBrief({ owner: null, glossary: [], session: { title: 'Họp', ended: null, languages: ['vi'], context: { participants: [{ name: 'Namfon' }], names: [{ name: 'Khamla', kind: 'mentioned' }, { name: 'Bao', kind: 'alias', of: 'Khamla' }, { name: 'Acme', kind: 'system' }] } } });
  assert.match(text, /\*\*Người dự \(1\):\*\*\n- Namfon/);
  assert.match(text, /\*\*Được nhắc \/ biệt danh \/ hệ thống \(3\):\*\* Khamla \(được nhắc, không dự\); Bao = Khamla; Acme \(hệ thống\)/);
});
