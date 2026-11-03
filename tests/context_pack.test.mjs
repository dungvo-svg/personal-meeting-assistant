// Context pack: version, provenance, binding/readiness rule, display-only corrections. Pure calls on fake data: no files,
// no process, no network, no audio.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPack, bindRole, readiness, applyCorrections, describeReadiness, CONTEXT_TABLES_SQL } from '../dist/context_pack.js';

const input = (over = {}) => ({
  sessionId: 's1', title: 'Họp mẫu', scheduledStart: '2026-11-04T02:00:00.000Z', me: 'Chủ họp', createdAt: '2026-11-04T01:00:00.000Z',
  agenda: '- Mục một\n- Mục hai',
  participants: [{ name: 'An', role: 'Trưởng nhóm', languages: ['vi'], variants: ['Ăn'] }, { name: 'Bo', languages: ['lo'] }],
  glossary: [{ name: 'Mẫu Co', kind: 'company', variants: ['Mau Ko'] }],
  docs: [{ label: 'Bảng giá', pointer: 'bang-gia.xlsx' }],
  ...over,
});
const READ = (pack, over = {}) => ({ pack, sessionId: 's1', asrListening: true, bindings: {}, role: 'chinh', consumerId: 'c1', ...over });
const bound = (pack, over = {}) => bindRole({}, { sessionId: 's1', role: 'chinh', consumerId: 'c1', generation: 1, version: pack.version, boundAt: '2026-11-04T01:00:01.000Z', ...over });

test('the same context gives the same version, whatever the row order or createdAt', () => {
  const a = buildPack(input());
  const b = buildPack(input({ createdAt: '2030-01-01T00:00:00.000Z', participants: [...input().participants].reverse() }));
  assert.equal(a.version, b.version);
  assert.match(a.version, /^[0-9a-f]{16}$/);
  assert.notEqual(a.createdAt, b.createdAt);
});

test('changed roster, agenda, glossary or correction gives a new version', () => {
  const base = buildPack(input()).version;
  assert.notEqual(buildPack(input({ participants: [{ name: 'An' }, { name: 'Cu' }] })).version, base);
  assert.notEqual(buildPack(input({ agenda: '- Mục một\n- Mục ba' })).version, base);
  assert.notEqual(buildPack(input({ glossary: [{ name: 'Mẫu Co', variants: ['Mau Ko', 'Mao Ko'] }] })).version, base);
  assert.notEqual(buildPack(input({ corrections: [{ raw: 'Mau Ko', corrected: 'Mẫu Co', at: 't1' }] })).version, base);
  assert.notEqual(buildPack(input({ sessionId: 's2' })).version, base);
});

test('every item carries its provenance', () => {
  const pack = buildPack(input({ corrections: [{ raw: 'Mau Ko', corrected: 'Mẫu Co', at: 't1', basis: 'user_confirmed', scope: 'meeting', sourceId: '#12', by: 'Chủ họp' }] }));
  assert.deepEqual(pack.roster.map(p => [p.name, p.source, p.basis]), [['An', 'participants_file', 'owner_stated'], ['Bo', 'participants_file', 'owner_stated']]);
  assert.deepEqual(pack.roster[0].aliases, ['Ăn']);
  assert.equal(pack.entities[0].source, 'glossary');
  assert.equal(pack.docs[0].source, 'owner_docs');
  assert.deepEqual(pack.topics, ['Mục một', 'Mục hai']);
  assert.deepEqual(pack.corrections[0], { raw: 'Mau Ko', corrected: 'Mẫu Co', sourceId: '#12', at: 't1', basis: 'user_confirmed', scope: 'meeting', by: 'Chủ họp' });
  assert.deepEqual(pack.meeting, { sessionId: 's1', title: 'Họp mẫu', scheduledStart: '2026-11-04T02:00:00.000Z' });
  assert.deepEqual(pack.missing, []);
  // an explicit source is kept, and inferred is the default basis of a correction
  const other = buildPack(input({ participants: [{ name: 'An', source: 'calendar', basis: 'inferred' }], corrections: [{ raw: 'x', corrected: 'y', at: 't' }] }));
  assert.deepEqual([other.roster[0].source, other.roster[0].basis, other.corrections[0].basis, other.corrections[0].scope], ['calendar', 'inferred', 'inferred', 'meeting']);
});

test('the same person or term twice is one item with merged aliases', () => {
  const pack = buildPack(input({ participants: [{ name: 'An', variants: ['Ăn'], languages: ['vi'] }, { name: 'an', variants: ['Ân', 'An'], languages: ['lo'] }] }));
  assert.equal(pack.roster.length, 1);
  assert.deepEqual(pack.roster[0].aliases, ['Ân', 'Ăn']);
  assert.deepEqual(pack.roster[0].languages, ['lo', 'vi']);
});

test('absent context is listed in missing and reads DEGRADED, not blocked', () => {
  const bare = buildPack({ sessionId: 's1', createdAt: 't' });
  assert.deepEqual(bare.missing, ['me', 'agenda', 'roster', 'entities']);
  const result = readiness(READ(bare, { bindings: bound(bare) }));
  assert.equal(result.state, 'DEGRADED');
  assert.deepEqual(result.reasons, ['MISSING:me', 'MISSING:agenda', 'MISSING:roster', 'MISSING:entities']);
  assert.match(describeReadiness(result), /thiếu: chưa biết owner là ai/);
  assert.throws(() => buildPack({ sessionId: '  ' }), /INVALID_CONTEXT_PACK/);
});

test('context + ASR listening + this consumer bound to the current version is READY', () => {
  const pack = buildPack(input());
  assert.deepEqual(readiness(READ(pack, { bindings: bound(pack) })), { state: 'READY', reasons: [] });
});

test('context only, ASR not listening is NOT_READY', () => {
  const pack = buildPack(input());
  assert.deepEqual(readiness(READ(pack, { asrListening: false, bindings: bound(pack) })), { state: 'NOT_READY', reasons: ['ASR_NOT_LISTENING'] });
});

test('ASR only, no context is DEGRADED NO_CONTEXT (capture continues; nothing is decided on that basis)', () => {
  assert.deepEqual(readiness(READ(undefined)), { state: 'DEGRADED', reasons: ['NO_CONTEXT'] });
  assert.deepEqual(readiness(READ(null)), { state: 'DEGRADED', reasons: ['NO_CONTEXT'] });
  assert.equal(readiness(READ(null, { asrListening: false })).state, 'NOT_READY');
  assert.match(describeReadiness({ state: 'DEGRADED', reasons: ['NO_CONTEXT'] }), /không chốt quyết định/);
});

test('right version but a different consumer is WRONG_CONSUMER', () => {
  const pack = buildPack(input());
  const bindings = bound(pack, { consumerId: 'c2' });
  assert.deepEqual(readiness(READ(pack, { bindings })), { state: 'NOT_READY', reasons: ['WRONG_CONSUMER'] });
  // another role holding the current version does not make this role ready either
  assert.deepEqual(readiness(READ(pack, { bindings: bound(pack, { role: 'dich' }) })), { state: 'NOT_READY', reasons: ['WRONG_CONSUMER'] });
});

test('a binding of another session is OTHER_SESSION', () => {
  const pack = buildPack(input());
  // the consumer only read another meeting's pack
  const elsewhere = bound(pack, { sessionId: 's0' });
  assert.deepEqual(readiness(READ(pack, { bindings: elsewhere })), { state: 'NOT_READY', reasons: ['OTHER_SESSION'] });
  // a pack of another session is never usable for this meeting, even when bound
  const alien = buildPack(input({ sessionId: 's0' }));
  assert.deepEqual(readiness(READ(alien, { bindings: bound(alien, { sessionId: 's0' }) })), { state: 'NOT_READY', reasons: ['OTHER_SESSION'] });
});

test('never bound is NEEDS_REBIND NOT_BOUND', () => {
  assert.deepEqual(readiness(READ(buildPack(input()))), { state: 'NEEDS_REBIND', reasons: ['NOT_BOUND'] });
});

test('a stale version is NEEDS_REBIND, and rebinding makes it READY', () => {
  const v1 = buildPack(input());
  const bindings = bound(v1);
  const v2 = buildPack(input({ participants: [{ name: 'An' }, { name: 'Cu' }] }));
  assert.notEqual(v1.version, v2.version);
  assert.deepEqual(readiness(READ(v2, { bindings })), { state: 'NEEDS_REBIND', reasons: ['STALE_CONTEXT'] });
  const after = bindRole(bindings, { sessionId: 's1', role: 'chinh', consumerId: 'c1', generation: 1, version: v2.version, boundAt: 't2' });
  assert.deepEqual(readiness(READ(v2, { bindings: after })), { state: 'READY', reasons: [] });
  assert.equal(bindings[Object.keys(bindings)[0]].version, v1.version, 'bindRole does not change the record it was given');
});

test('a restarted process (generation + 1) must read again; an older generation cannot overwrite the newer', () => {
  const pack = buildPack(input());
  const g1 = bound(pack, { generation: 1 });
  assert.deepEqual(readiness(READ(pack, { bindings: g1, generation: 2 })), { state: 'NEEDS_REBIND', reasons: ['STALE_GENERATION'] });
  const g2 = bindRole(g1, { sessionId: 's1', role: 'chinh', consumerId: 'c1', generation: 2, version: pack.version, boundAt: 't' });
  assert.equal(readiness(READ(pack, { bindings: g2, generation: 2 })).state, 'READY');
  assert.equal(bindRole(g2, { sessionId: 's1', role: 'chinh', consumerId: 'c1', generation: 1, version: 'old', boundAt: 't' }), g2, 'the zombie of generation 1 is ignored');
  assert.deepEqual(readiness(READ(pack, { bindings: g2, generation: 1 })), { state: 'NOT_READY', reasons: ['SUPERSEDED'] });
});

test('corrections change only exact listed raw strings; "Ta"/"tôi" are untouched unless listed', () => {
  const corrections = buildPack(input({ corrections: [{ raw: 'Mau Ko', corrected: 'Mẫu Co', at: 't1', basis: 'user_confirmed' }] })).corrections;
  const text = 'Ta nói Mau Ko đã gửi, tôi thấy Mau Kone và Tar cũng vậy.';
  assert.equal(applyCorrections(text, corrections), 'Ta nói Mẫu Co đã gửi, tôi thấy Mau Kone và Tar cũng vậy.');
  assert.equal(applyCorrections(text, []), text);
  assert.equal(applyCorrections(text, undefined), text);
  // exact, case-sensitive, whole token: listing "Ta" does not touch "Tar" or "ta"
  const listed = [{ raw: 'Ta', corrected: 'Tà', at: 't', basis: 'user_confirmed', scope: 'meeting' }];
  assert.equal(applyCorrections('Ta và Tar và ta', listed), 'Tà và Tar và ta');
  // single pass: a replacement is not corrected again; the stored text value is a plain string and stays as it was
  const chain = [{ raw: 'a', corrected: 'b', at: '1', basis: 'user_confirmed', scope: 'meeting' }, { raw: 'b', corrected: 'c', at: '2', basis: 'user_confirmed', scope: 'meeting' }];
  assert.equal(applyCorrections('a b', chain), 'b c');
  assert.equal(text.includes('Mau Ko'), true);
});

test('an inferred correction keeps the heard form visible; the latest one on the same raw wins', () => {
  const corrections = [
    { raw: 'Nam Phủ', corrected: 'Namfon', at: '2026-11-04T01:00:00Z', basis: 'inferred', scope: 'meeting' },
    { raw: 'Nam Phủ', corrected: 'Nam Phu', at: '2026-11-04T02:00:00Z', basis: 'user_confirmed', scope: 'meeting' },
  ];
  assert.equal(applyCorrections('Nam Phủ báo', corrections), 'Nam Phu báo');
  assert.equal(applyCorrections('Nam Phủ báo', [corrections[0]]), 'Namfon (nghe: Nam Phủ) báo');
});

test('scope is respected: meeting display takes meeting + company, company display takes company only', () => {
  const corrections = [
    { raw: 'xx', corrected: 'meeting-fix', at: '1', basis: 'user_confirmed', scope: 'meeting' },
    { raw: 'yy', corrected: 'company-fix', at: '2', basis: 'user_confirmed', scope: 'company' },
  ];
  assert.equal(applyCorrections('xx yy', corrections, 'meeting'), 'meeting-fix company-fix');
  assert.equal(applyCorrections('xx yy', corrections, 'company'), 'xx company-fix');
});

test('suggested DDL names both tables and their columns', () => {
  for (const word of ['context_packs', 'context_bindings', 'session_id', 'version', 'created', 'json', 'role', 'consumer_id', 'generation', 'bound_at']) assert.ok(CONTEXT_TABLES_SQL.includes(word), word);
});
