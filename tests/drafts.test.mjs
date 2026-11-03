// Drafts contract: schema, admit rules, replay/timeout, receipts as four separate facts. Pure calls on fake data: no files, no
// process, no network, no audio, no clock of its own. Every state is deep-frozen, so any function that mutates its input throws.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DRAFT_KINDS, AFTERWARDS_KINDS, ACTION_KINDS, emptyState, openSession, setContextVersion, endSession, withdrawSession, bindConsumer,
  admit, saveOutcome, markDelivered, confirm, markActionDone, receiptOf, validateDraft,
} from '../dist/drafts.js';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';
const V1 = '0123456789abcdef';
const V2 = 'fedcba9876543210';
const ZERO = '0'.repeat(64);

const deepFreeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const inner of Object.values(value)) deepFreeze(inner); } return value; };
const step = result => { assert.equal(result.ok, true, 'step refused: ' + result.reason + ' ' + (result.detail ?? '')); return deepFreeze(result.state); };

// One open meeting S1 whose context is V1, with consumer chinh-1 bound at generation 1.
const meeting = () => {
  let state = openSession(emptyState(), S1, V1, 1000);
  state = step(bindConsumer(state, { sessionId: S1, consumerId: 'chinh-1', generation: 1, version: V1 }, 1001));
  return deepFreeze(state);
};
const bind = (state, consumerId, generation = 1, version = V1, sessionId = S1) => step(bindConsumer(state, { sessionId, consumerId, generation, version }, 1500));

const PIC = { text: 'Bức tranh cả cuộc họp', sourceIds: [3, 1, 2] };
const VALID = {
  picture: PIC,
  translations: { items: [{ sourceId: 5, text: 'xin chào' }, { sourceId: 4, text: 'đồng ý' }] },
  participants: { participants: [{ name: 'An', role: 'Trưởng nhóm', languages: ['vi'], variants: ['Ăn'], basis: 'owner_stated' }, { name: 'Bo', languages: ['lo', 'th'] }] },
  summary: { markdown: '# SUMMARY\n- Mục một', sourceIds: [1, 2] },
  tasks: { tasks: [{ task: 'Gửi báo giá', owner: 'An', due: 'thứ Sáu', ownerBasis: 'stated', sourceIds: [7] }] },
};
const env = (kind, content, over = {}) => ({ kind, sessionId: S1, consumerId: 'chinh-1', generation: 1, contextVersion: V1, expectedRevision: 0, idempotencyKey: 'k-' + kind + '-1', content, ...over });

// admit + the two invariants that must hold for EVERY call: a refusal returns the same state object, and ok:true always comes with
// the `saved` fact for that revision and that hash in the returned state (never success without saved).
const adm = (state, envelope, at = 2000) => {
  const result = admit(state, envelope, at); deepFreeze(result.state);
  if (!result.ok) assert.equal(result.state, state, 'a refusal must return the same state');
  else { const saved = receiptOf(result.state, envelope.sessionId, result.kind, result.revision).saved; assert.ok(saved, 'ok without a saved fact'); assert.equal(saved.contentHash, result.contentHash); }
  return result;
};
const refused = (result, reason) => { assert.equal(result.ok, false, 'expected ' + reason + ' but got ok'); assert.equal(result.reason, reason, result.detail); return result; };
const saved = (state, envelope) => { const r = adm(state, envelope); assert.equal(r.ok, true, r.reason + ' ' + (r.detail ?? '')); return r; };

// ---- schema --------------------------------------------------------------------------------------------------------------------
test('every kind has a fixed schema that accepts its valid content and normalises it', () => {
  assert.deepEqual([...DRAFT_KINDS], ['picture', 'translations', 'participants', 'summary', 'tasks']);
  assert.deepEqual(Object.keys(VALID), [...DRAFT_KINDS]);
  for (const kind of DRAFT_KINDS) {
    const r = saved(meeting(), env(kind, VALID[kind]));
    assert.equal(r.revision, 1); assert.equal(r.duplicate, false); assert.match(r.contentHash, /^[0-9a-f]{64}$/);
  }
  assert.equal(validateDraft('tasks', { tasks: [] }).ok, true, 'an empty task list is a valid draft');
  // source ids: unique and sorted; text: trimmed; the hash does not depend on key order, id order or blanks
  const a = saved(meeting(), env('picture', { text: '  Bức tranh cả cuộc họp ', sourceIds: [3, 1, 2, 2] }));
  const b = saved(meeting(), env('picture', { sourceIds: [1, 2, 3], text: 'Bức tranh cả cuộc họp' }));
  assert.equal(a.contentHash, b.contentHash);
  assert.deepEqual(receiptOf(a.state, S1, 'picture', 1).saved.content, { text: 'Bức tranh cả cuộc họp', sourceIds: [1, 2, 3] });
  assert.notEqual(validateDraft('picture', { text: 'x', sourceIds: [1] }).contentHash, validateDraft('picture', { text: 'y', sourceIds: [1] }).contentHash);
});

const bigIds = n => Array.from({ length: n }, (_, i) => i + 1);
const getter = (() => { const o = { sourceIds: [1] }; Object.defineProperty(o, 'text', { enumerable: true, get() { return 'x'; } }); return o; })();
const klass = new (class Sneaky { constructor() { this.text = 'x'; this.sourceIds = [1]; } })();
const symbolKey = { ...PIC, [Symbol('s')]: 1 };
const REJECT = [
  // a draft is content, never a location or an instruction: no path field, no command field
  ['picture', { ...PIC, path: 'C:\\Users\\x\\.local\\out.md' }, 'FORBIDDEN_KEY'],
  ['picture', { ...PIC, file: 'x.md' }, 'FORBIDDEN_KEY'],
  ['picture', { ...PIC, filePath: '../x' }, 'FORBIDDEN_KEY'],
  ['picture', { ...PIC, url: 'http://example.test' }, 'FORBIDDEN_KEY'],
  ['picture', { ...PIC, command: 'rm -rf /' }, 'FORBIDDEN_KEY'],
  ['picture', { ...PIC, cmd: 'dir' }, 'FORBIDDEN_KEY'],
  ['picture', { ...PIC, exec: 'node x.js' }, 'FORBIDDEN_KEY'],
  ['picture', { ...PIC, script: 'x' }, 'FORBIDDEN_KEY'],
  ['picture', JSON.parse('{"text":"x","sourceIds":[1],"__proto__":{"a":1}}'), 'FORBIDDEN_KEY'],
  ['summary', { ...VALID.summary, shell: 'bash' }, 'FORBIDDEN_KEY'],
  ['translations', { items: [{ sourceId: 1, text: 'a', path: 'x' }] }, 'FORBIDDEN_KEY'],
  ['participants', { participants: [{ name: 'An', exec: 'x' }] }, 'FORBIDDEN_KEY'],
  ['tasks', { tasks: [{ task: 'x', sourceIds: [1], command: 'x' }] }, 'FORBIDDEN_KEY'],
  // authority-looking KEYS are just unknown keys
  ['picture', { ...PIC, approved: true }, 'UNKNOWN_KEY'],
  ['summary', { ...VALID.summary, decision: 'decided' }, 'UNKNOWN_KEY'],
  ['tasks', { tasks: [{ task: 'x', sourceIds: [1], authority: 'ceo' }] }, 'UNKNOWN_KEY'],
  ['participants', { participants: [{ name: 'An', grant: '*' }] }, 'UNKNOWN_KEY'],
  ['picture', { ...PIC, foo: 1 }, 'UNKNOWN_KEY'],
  // shape
  ['picture', null, 'NOT_AN_OBJECT'], ['picture', [PIC], 'NOT_AN_OBJECT'], ['picture', 'text', 'NOT_AN_OBJECT'],
  ['picture', klass, 'NOT_PLAIN_OBJECT'], ['picture', getter, 'ACCESSOR_KEY'], ['picture', symbolKey, 'SYMBOL_KEY'],
  ['picture', { text: 'x' }, 'MISSING_KEY'], ['picture', { sourceIds: [1] }, 'MISSING_KEY'],
  // source ids are positive integers
  ['picture', { text: 'x', sourceIds: [0] }, 'BAD_INTEGER'], ['picture', { text: 'x', sourceIds: [-1] }, 'BAD_INTEGER'],
  ['picture', { text: 'x', sourceIds: [1.5] }, 'BAD_INTEGER'], ['picture', { text: 'x', sourceIds: ['3'] }, 'BAD_INTEGER'],
  ['picture', { text: 'x', sourceIds: [NaN] }, 'BAD_INTEGER'], ['picture', { text: 'x', sourceIds: [Number.MAX_SAFE_INTEGER + 1] }, 'BAD_INTEGER'],
  ['picture', { text: 'x', sourceIds: [] }, 'BAD_LENGTH'], ['picture', { text: 'x', sourceIds: bigIds(51) }, 'BAD_LENGTH'], ['picture', { text: 'x', sourceIds: 'x' }, 'NOT_AN_ARRAY'],
  ['summary', { markdown: 'x', sourceIds: bigIds(201) }, 'BAD_LENGTH'],
  // sizes
  ['picture', { text: 'x'.repeat(30001), sourceIds: [1] }, 'BAD_LENGTH'], ['picture', { text: '   ', sourceIds: [1] }, 'BAD_LENGTH'],
  ['picture', { text: 5, sourceIds: [1] }, 'NOT_A_STRING'], ['picture', { text: 'a\0b', sourceIds: [1] }, 'NUL_IN_TEXT'],
  ['summary', { markdown: 'x'.repeat(40001), sourceIds: [1] }, 'BAD_LENGTH'],
  ['translations', { items: [] }, 'BAD_LENGTH'], ['translations', { items: Array.from({ length: 101 }, (_, i) => ({ sourceId: i + 1, text: 'a' })) }, 'BAD_LENGTH'],
  ['translations', { items: [{ sourceId: 1, text: 'x'.repeat(2001) }] }, 'BAD_LENGTH'], ['translations', { items: [{ sourceId: 0, text: 'a' }] }, 'BAD_INTEGER'],
  ['translations', { items: [{ sourceId: 1, text: 'a' }, { sourceId: 1, text: 'b' }] }, 'DUPLICATE_ENTRY'],
  ['participants', { participants: [{ name: 'An', languages: ['en'] }] }, 'BAD_VALUE'], ['participants', { participants: [{ name: 'An', basis: 'boss_said' }] }, 'BAD_VALUE'],
  ['participants', { participants: [{ name: 'An' }, { name: 'an' }] }, 'DUPLICATE_ENTRY'], ['participants', { participants: [] }, 'BAD_LENGTH'],
  ['tasks', { tasks: [{ task: 'x', sourceIds: [1], ownerBasis: 'approved' }] }, 'BAD_VALUE'], ['tasks', { tasks: [{ task: 'x' }] }, 'MISSING_KEY'],
  ['tasks', { tasks: Array.from({ length: 201 }, (_, i) => ({ task: 't' + i, sourceIds: [1] })) }, 'BAD_LENGTH'],
];
test('a path-like, command-like or unknown field, a bad source id or an oversize text is rejected by the schema', () => {
  for (const [kind, content, code] of REJECT) {
    const checked = validateDraft(kind, content);
    assert.equal(checked.ok, false, kind + ' ' + code + ' was accepted');
    assert.equal(checked.code, code, kind + ' expected ' + code + ' got ' + checked.code + ' at ' + checked.path);
    const state = meeting(), result = adm(state, env(kind, content));
    refused(result, 'INVALID_CONTENT'); assert.ok(result.detail.startsWith(code), result.detail);
    assert.deepEqual(state.revisions, {}, 'nothing may be stored');
  }
  assert.match(validateDraft('tasks', REJECT.find(r => r[0] === 'tasks' && r[2] === 'FORBIDDEN_KEY')[1]).path, /content\.tasks\[0\]\.command/);
  assert.equal(validateDraft('path', PIC).ok, false);
});

test('the envelope is closed too: an unknown or path-like key, a path-like id and a bad integer are INVALID_ENVELOPE', () => {
  const bad = [
    [{ ...env('picture', PIC), path: 'C:\\x' }, 'FORBIDDEN_KEY'], [{ ...env('picture', PIC), command: 'x' }, 'FORBIDDEN_KEY'], [{ ...env('picture', PIC), cmd: 'x' }, 'FORBIDDEN_KEY'],
    [{ ...env('picture', PIC), approved: true }, 'UNKNOWN_KEY'],
    [env('picture', PIC, { consumerId: '../x' }), 'BAD_ID'], [env('picture', PIC, { consumerId: '/etc/passwd' }), 'BAD_ID'], [env('picture', PIC, { consumerId: 'C:\\x' }), 'BAD_ID'],
    [env('picture', PIC, { consumerId: 'a b' }), 'BAD_ID'], [env('picture', PIC, { consumerId: '' }), 'BAD_ID'],
    [env('picture', PIC, { sessionId: 'x/y' }), 'BAD_ID'], [env('picture', PIC, { idempotencyKey: 'a\\b' }), 'BAD_ID'], [env('picture', PIC, { contextVersion: '../v' }), 'BAD_ID'],
    [env('picture', PIC, { generation: -1 }), 'BAD_INTEGER'], [env('picture', PIC, { generation: 1.5 }), 'BAD_INTEGER'], [env('picture', PIC, { generation: '1' }), 'BAD_INTEGER'],
    [env('picture', PIC, { expectedRevision: 1.5 }), 'BAD_INTEGER'], [env('picture', PIC, { expectedRevision: -1 }), 'BAD_INTEGER'],
    [env('path', PIC), 'BAD_VALUE'], [env('picture', undefined), 'MISSING_KEY'],
    [null, 'NOT_AN_OBJECT'], [undefined, 'NOT_AN_OBJECT'], [[], 'NOT_AN_OBJECT'], ['picture', 'NOT_AN_OBJECT'], [5, 'NOT_AN_OBJECT'],
  ];
  for (const [envelope, code] of bad) { const r = refused(adm(meeting(), envelope), 'INVALID_ENVELOPE'); assert.ok(r.detail.startsWith(code), code + ' vs ' + r.detail); }
});

// ---- admit: the rules ----------------------------------------------------------------------------------------------------------
test('revisions are per (session, kind); a caller that mutates its input afterwards changes nothing stored', () => {
  const e = env('picture', { text: 'a', sourceIds: [1, 2] });
  const r1 = saved(meeting(), e);
  e.content.sourceIds.push(99); e.content.text = 'z';
  assert.deepEqual(receiptOf(r1.state, S1, 'picture', 1).saved.content, { text: 'a', sourceIds: [1, 2] });
  const r2 = saved(r1.state, env('picture', { text: 'b', sourceIds: [1] }, { expectedRevision: 1, idempotencyKey: 'k2' }));
  assert.equal(r2.revision, 2);
  const t = saved(r2.state, env('tasks', VALID.tasks));            // another kind starts at its own 0
  assert.equal(t.revision, 1);
  assert.equal(receiptOf(t.state, S1, 'picture', 1).saved.content.text, 'a', 'older revisions stay as history');
});

test('WRONG MEETING: a draft for another session is OTHER_SESSION; a closed meeting stays closed; one active meeting at a time', () => {
  const state = meeting();
  refused(adm(state, env('picture', PIC, { sessionId: S2 })), 'OTHER_SESSION');
  const next = deepFreeze(openSession(endSession(state, S1, 2500), S2, V2, 3000));
  refused(adm(next, env('picture', PIC, { sessionId: S3 })), 'OTHER_SESSION');
  refused(adm(next, env('picture', PIC, { idempotencyKey: 'late' })), 'SESSION_CLOSED');                       // S1 ended: a picture of it is late
  refused(adm(next, env('picture', PIC, { sessionId: S2, contextVersion: V2 })), 'NOT_BOUND');                 // chinh-1 read S1's context, not S2's
  assert.throws(() => openSession(next, S3, V1, 3100), /SESSION_ALREADY_ACTIVE/);
  assert.throws(() => openSession(next, S1, V1, 3100), /SESSION_ALREADY_KNOWN/);
});

test('WRONG CONSUMER / STALE CONTEXT: only a consumer bound at this generation to the current context version may write', () => {
  const state = meeting();
  refused(adm(state, env('picture', PIC, { consumerId: 'dich-1' })), 'NOT_BOUND');                              // never read the context
  refused(adm(state, env('picture', PIC, { generation: 2 })), 'NOT_BOUND');                                     // restarted, has not read it again
  const none = step(bindConsumer(openSession(emptyState(), S1, null, 1), { sessionId: S1, consumerId: 'chinh-1', generation: 1, version: V1 }, 2));
  refused(adm(none, env('picture', PIC)), 'NOT_BOUND');                                                         // the meeting has no context yet

  const changed = deepFreeze(setContextVersion(state, S1, V2, 1500));
  refused(adm(changed, env('picture', PIC)), 'STALE_CONTEXT');                                                  // consumer still on V1
  refused(adm(changed, env('picture', PIC, { contextVersion: V2 })), 'STALE_CONTEXT');                          // draft claims V2, consumer never read it
  const rebound = bind(changed, 'chinh-1', 1, V2);
  refused(adm(rebound, env('picture', PIC)), 'STALE_CONTEXT');                                                  // consumer on V2 but the draft says V1
  assert.equal(saved(rebound, env('picture', PIC, { contextVersion: V2 })).revision, 1);

  const other = bind(state, 'dich-1', 1, V2);                                                                   // another consumer bound to a different version
  refused(adm(other, env('picture', PIC, { consumerId: 'dich-1', contextVersion: V2 })), 'STALE_CONTEXT');
  assert.equal(saved(other, env('picture', PIC)).revision, 1, 'chinh-1 is unaffected by dich-1');
});

test('STALE REVISION: expectedRevision must equal the current revision of that kind', () => {
  const r1 = saved(meeting(), env('picture', PIC));
  const stale = refused(adm(r1.state, env('picture', { text: 'b', sourceIds: [1] }, { idempotencyKey: 'b' })), 'STALE_REVISION');
  assert.equal(stale.currentRevision, 1);
  refused(adm(r1.state, env('picture', { text: 'b', sourceIds: [1] }, { idempotencyKey: 'c', expectedRevision: 5 })), 'STALE_REVISION');
  assert.equal(saved(r1.state, env('picture', { text: 'b', sourceIds: [1] }, { idempotencyKey: 'd', expectedRevision: 1 })).revision, 2);
});

test('REPLAY: the same key with the same content is a duplicate (no new revision); the same key with other content is KEY_CONFLICT', () => {
  const e = env('picture', PIC);
  const r1 = saved(meeting(), e);
  // same content in another key order and with a stale expectedRevision: still the same replay
  const again = adm(r1.state, { ...e, content: { sourceIds: [1, 2, 3, 3], text: PIC.text }, expectedRevision: 0 });
  assert.equal(again.ok, true); assert.equal(again.duplicate, true); assert.equal(again.revision, 1); assert.equal(again.state, r1.state);

  const conflict = refused(adm(r1.state, env('picture', { text: 'khác', sourceIds: [1] })), 'KEY_CONFLICT');
  assert.equal(receiptOf(conflict.state, S1, 'picture', 1).saved.contentHash, r1.contentHash, 'the first content stays the record');
  refused(adm(r1.state, env('summary', VALID.summary, { idempotencyKey: e.idempotencyKey })), 'KEY_CONFLICT');   // same key, another kind
  // another consumer's key is its own: no cross-talk
  const other = bind(r1.state, 'dich-1');
  assert.equal(saved(other, env('picture', { text: 'dịch', sourceIds: [1] }, { consumerId: 'dich-1', expectedRevision: 1 })).revision, 2);
  // same content under a NEW key at the current revision: not a new revision either; the new key then replays
  const same = adm(r1.state, env('picture', PIC, { idempotencyKey: 'other-key', expectedRevision: 1 }));
  assert.equal(same.duplicate, true); assert.equal(same.revision, 1); assert.deepEqual(same.state.revisions, r1.state.revisions);
  assert.equal(adm(same.state, env('picture', PIC, { idempotencyKey: 'other-key', expectedRevision: 1 })).duplicate, true);
  refused(adm(r1.state, env('picture', PIC, { idempotencyKey: 'stale-key', expectedRevision: 0 })), 'STALE_REVISION');
});

test('TIMEOUT AFTER SAVE: unknown outcome resolves to duplicate (saved) or a clean retry; never a double save, a lost draft or a success without saved', () => {
  const s0 = meeting(), e = env('picture', PIC);
  const landed = saved(s0, e);                         // the host stored it; the caller never saw the reply
  assert.deepEqual(saveOutcome(landed.state, S1, 'chinh-1', e.idempotencyKey), { saved: true, kind: 'picture', revision: 1, contentHash: landed.contentHash });
  const retry = adm(landed.state, e, 3000);
  assert.equal(retry.ok, true); assert.equal(retry.duplicate, true); assert.equal(retry.revision, 1);
  assert.equal(Object.keys(retry.state.saved).length, 1, 'no second revision');
  assert.equal(adm(retry.state, e, 3100).revision, 1);
  // the retry arrives after the context moved on and the meeting ended: still "saved at 1", not stale and not closed
  const later = deepFreeze(endSession(setContextVersion(landed.state, S1, V2, 2500), S1, 2600));
  const lateRetry = adm(later, e, 3200); assert.equal(lateRetry.duplicate, true); assert.equal(lateRetry.revision, 1);
  // the caller changes its mind under the same key: refused, the draft already stored is intact
  const changed = refused(adm(landed.state, { ...e, content: { text: 'đổi', sourceIds: [1] } }), 'KEY_CONFLICT');
  assert.equal(receiptOf(changed.state, S1, 'picture', 1).saved.contentHash, landed.contentHash);
  // the host died BEFORE storing: the state has nothing, so the same call is a first save, not a duplicate
  assert.deepEqual(saveOutcome(s0, S1, 'chinh-1', e.idempotencyKey), { saved: false });
  const fresh = adm(s0, e, 3000); assert.equal(fresh.ok, true); assert.equal(fresh.duplicate, false); assert.equal(fresh.revision, 1);
  assert.deepEqual(saveOutcome(s0, S1, 'dich-1', e.idempotencyKey), { saved: false }, 'another consumer\'s key is not mine');
});

// ---- receipts: four separate facts ---------------------------------------------------------------------------------------------
const delivered = () => {
  const r = saved(meeting(), env('picture', PIC));
  let state = bind(r.state, 'dich-1', 1);
  state = step(markDelivered(state, { sessionId: S1, kind: 'picture', revision: 1, consumerId: 'dich-1', generation: 1 }, 2002));
  return { state, hash: r.contentHash, undelivered: bind(r.state, 'dich-1', 1) };
};
const CONF = hash => ({ sessionId: S1, kind: 'picture', consumerId: 'dich-1', generation: 1, revision: 1, contentHash: hash, contextVersion: V1 });
const confirmRefused = (state, input, reason) => { const r = confirm(state, input, 4000); assert.equal(r.ok, false, 'expected ' + reason); assert.equal(r.reason, reason, r.detail); assert.equal(r.state, state); assert.deepEqual(receiptOf(state, S1, 'picture', 1).confirmedByConsumer, []); return r; };

test('CONFIRM: only that consumer, at that generation, for that revision, hash and context version', () => {
  const { state, hash, undelivered } = delivered();
  confirmRefused(undelivered, CONF(hash), 'NOT_DELIVERED');                                      // nothing was handed over
  confirmRefused(state, { ...CONF(hash), contextVersion: V2 }, 'WRONG_CONTEXT');                  // ACK with the wrong context version
  confirmRefused(state, CONF(ZERO), 'WRONG_HASH');                                                // ACK with the wrong hash
  confirmRefused(state, CONF('abc'), 'INVALID_INPUT');
  confirmRefused(state, { ...CONF(hash), revision: 9 }, 'UNKNOWN_REVISION');
  confirmRefused(state, { ...CONF(hash), sessionId: S2 }, 'OTHER_SESSION');
  confirmRefused(state, { ...CONF(hash), consumerId: 'chinh-1' }, 'WRONG_CONSUMER');              // delivered to dich-1, confirmed by chinh-1
  confirmRefused(state, { ...CONF(hash), ack: true }, 'INVALID_INPUT'); confirmRefused(state, { ...CONF(hash), path: 'x' }, 'INVALID_INPUT');
  // an old generation: dich-1 restarted (generation 2); generation 1's confirmation is late, generation 2 never got the draft
  const restarted = bind(state, 'dich-1', 2);
  confirmRefused(restarted, CONF(hash), 'STALE_GENERATION');
  confirmRefused(restarted, { ...CONF(hash), generation: 2 }, 'NOT_DELIVERED');
  const handed = step(markDelivered(restarted, { sessionId: S1, kind: 'picture', revision: 1, consumerId: 'dich-1', generation: 2 }, 4100));
  assert.equal(confirm(handed, { ...CONF(hash), generation: 2 }, 4200).ok, true);

  const done = confirm(state, CONF(hash), 4000); assert.equal(done.ok, true); deepFreeze(done.state);
  const [fact, ...rest] = receiptOf(done.state, S1, 'picture', 1).confirmedByConsumer;
  assert.equal(rest.length, 0);
  assert.deepEqual({ consumerId: fact.consumerId, generation: fact.generation, revision: fact.revision, contentHash: fact.contentHash, contextVersion: fact.contextVersion }, { consumerId: 'dich-1', generation: 1, revision: 1, contentHash: hash, contextVersion: V1 });
  const again = confirm(done.state, CONF(hash), 4300); assert.equal(again.duplicate, true); assert.equal(again.state, done.state);
  // the meeting moved to a newer context afterwards: the fact is about the version the draft was saved under
  const moved = deepFreeze(setContextVersion(state, S1, V2, 3500));
  confirmRefused(moved, { ...CONF(hash), contextVersion: V2 }, 'WRONG_CONTEXT');
  assert.equal(confirm(moved, CONF(hash), 4000).ok, true);
});

test('DELIVER: handing a draft to a consumer that does not hold the right context is not a delivery', () => {
  const r = saved(meeting(), env('picture', PIC));
  const base = { sessionId: S1, kind: 'picture', revision: 1, consumerId: 'x-1', generation: 1 };
  assert.equal(markDelivered(r.state, base, 1).reason, 'NOT_BOUND');
  const wrong = bind(r.state, 'x-1', 1, V2);
  assert.equal(markDelivered(wrong, base, 1).reason, 'STALE_CONTEXT');
  assert.equal(markDelivered(wrong, { ...base, revision: 4 }, 1).reason, 'UNKNOWN_REVISION');
  assert.equal(markDelivered(wrong, { ...base, sessionId: S2 }, 1).reason, 'OTHER_SESSION');
  assert.equal(markDelivered(wrong, { ...base, path: 'x' }, 1).reason, 'INVALID_INPUT');
  const old = bind(bind(r.state, 'x-1', 2), 'y-1', 1);
  assert.equal(markDelivered(old, { ...base, generation: 1 }, 1).reason, 'STALE_GENERATION');
  assert.equal(markDelivered(old, { ...base, consumerId: 'y-1' }, 1).ok, true);
});

test('A HOST OR TRANSPORT ACK NEVER YIELDS confirmedByConsumer: it is `delivered` and nothing more', () => {
  const r = saved(meeting(), env('picture', PIC));
  let state = bind(bind(r.state, 'dich-1'), 'chinh-1');
  const base = { sessionId: S1, kind: 'picture', revision: 1, generation: 1 };
  state = step(markDelivered(state, { ...base, consumerId: 'dich-1' }, 2100));
  const ack = markDelivered(state, { ...base, consumerId: 'dich-1' }, 2200);                       // the transport ACKs again
  assert.equal(ack.ok, true); assert.equal(ack.duplicate, true);
  state = step(markDelivered(state, { ...base, consumerId: 'chinh-1' }, 2300));
  // every other writer in the module, run in turn: none of them may create a confirmed fact
  state = saved(state, env('picture', { text: 'b', sourceIds: [1] }, { expectedRevision: 1, idempotencyKey: 'k2' })).state;
  state = bind(state, 'dich-1', 1);
  state = deepFreeze(endSession(state, S1, 2400));
  assert.deepEqual(state.confirmed, {});
  const receipt = receiptOf(state, S1, 'picture', 1);
  assert.equal(receipt.saved.revision, 1); assert.equal(receipt.delivered.length, 2);
  assert.deepEqual(receipt.confirmedByConsumer, []); assert.deepEqual(receipt.actionDone, []);
  // a "confirmation" that is really a host/transport reply carries extra marks or the wrong facts: refused
  const base2 = CONF(r.contentHash);
  for (const forged of [{ ...base2, from: 'host' }, { ...base2, ack: true }, { ...base2, ok: true }, { sessionId: S1, revision: 1 }, { ...base2, consumerId: 'host' }]) assert.equal(confirm(state, forged, 3000).ok, false);
  assert.deepEqual(state.confirmed, {});
  // only the consumer's own confirm creates it, and only for that consumer
  const own = confirm(state, base2, 3100); assert.equal(own.ok, true);
  const facts = receiptOf(own.state, S1, 'picture', 1);
  assert.deepEqual(facts.confirmedByConsumer.map(c => c.consumerId), ['dich-1']);
  assert.equal(facts.delivered.length, 2, 'delivered stays its own fact');
});

test('ACTION DONE is its own fact: it does not need, imply or produce a confirmation, and a draft\'s text decides nothing', () => {
  let state = saved(meeting(), env('participants', VALID.participants, { idempotencyKey: 'p1' })).state;
  const hash = receiptOf(state, S1, 'participants', 1).saved.contentHash;
  const done = { sessionId: S1, kind: 'participants', revision: 1, contentHash: hash, action: 'Áp dụng vào bảng tên', by: 'host' };
  assert.equal(markActionDone(state, { ...done, contentHash: ZERO }, 1).reason, 'WRONG_HASH');
  assert.equal(markActionDone(state, { ...done, revision: 7 }, 1).reason, 'UNKNOWN_REVISION');
  assert.equal(markActionDone(state, { ...done, run: 'rm -rf /' }, 1).reason, 'INVALID_INPUT');
  assert.equal(markActionDone(state, { ...done, sessionId: S2 }, 1).reason, 'OTHER_SESSION');
  state = step(markActionDone(state, done, 2100));
  assert.equal(markActionDone(state, done, 2200).duplicate, true);
  state = step(markActionDone(state, { ...done, action: 'rm -rf /' }, 2300));                       // recorded as plain text, never run
  const receipt = receiptOf(state, S1, 'participants', 1);
  assert.deepEqual(receipt.actionDone.map(a => a.action), ['Áp dụng vào bảng tên', 'rm -rf /']);
  assert.deepEqual(receipt.delivered, []); assert.deepEqual(receipt.confirmedByConsumer, []);
  assert.deepEqual(ACTION_KINDS, ['participants', 'tasks']);
  const pic = saved(meeting(), env('picture', PIC));
  assert.equal(markActionDone(pic.state, { sessionId: S1, kind: 'picture', revision: 1, contentHash: pic.contentHash, action: 'x', by: 'host' }, 1).reason, 'ACTION_NOT_APPLICABLE');
  // and the other way: delivered + confirmed create no actionDone
  let t = saved(meeting(), env('tasks', VALID.tasks)); const tHash = t.contentHash; t = bind(t.state, 'dich-1');
  t = step(markDelivered(t, { sessionId: S1, kind: 'tasks', revision: 1, consumerId: 'dich-1', generation: 1 }, 2));
  t = step(confirm(t, { sessionId: S1, kind: 'tasks', consumerId: 'dich-1', generation: 1, revision: 1, contentHash: tHash, contextVersion: V1 }, 3));
  const tr = receiptOf(t, S1, 'tasks', 1); assert.equal(tr.confirmedByConsumer.length, 1); assert.deepEqual(tr.actionDone, []);
});

// ---- session end / withdraw, late generations ----------------------------------------------------------------------------------
test('STOP / WITHDRAW then a late draft: SESSION_CLOSED, and what was already saved stays', () => {
  const r1 = saved(meeting(), env('picture', PIC));
  const withdrawn = deepFreeze(withdrawSession(r1.state, S1, 3000));
  assert.equal(withdrawn.activeSessionId, null);
  const late = (kind, content, key) => env(kind, content, { idempotencyKey: key, expectedRevision: kind === 'picture' ? 1 : 0 });
  refused(adm(withdrawn, late('picture', { text: 'muộn', sourceIds: [1] }, 'late-1')), 'SESSION_CLOSED');
  refused(adm(withdrawn, late('summary', VALID.summary, 'late-2')), 'SESSION_CLOSED');
  refused(adm(withdrawn, late('tasks', VALID.tasks, 'late-3')), 'SESSION_CLOSED');
  assert.equal(receiptOf(withdrawn, S1, 'picture', 1).saved.contentHash, r1.contentHash, 'never deleted');
  assert.equal(adm(withdrawn, env('picture', PIC)).duplicate, true, 'a replay of what was saved is still answered "saved"');
  assert.equal(markDelivered(withdrawn, { sessionId: S1, kind: 'picture', revision: 1, consumerId: 'chinh-1', generation: 1 }, 1).reason, 'SESSION_CLOSED');
  assert.equal(withdrawSession(withdrawn, S1, 4000), withdrawn);
  assert.throws(() => openSession(withdrawn, S1, V1, 4000), /SESSION_ALREADY_KNOWN/);
});

test('ENDED meeting: live kinds are closed, the afterwards kinds (summary, tasks) are still accepted, withdrawn closes them too', () => {
  assert.deepEqual(AFTERWARDS_KINDS, ['summary', 'tasks']);
  const ended = deepFreeze(endSession(meeting(), S1, 3000));
  for (const kind of ['picture', 'translations', 'participants']) refused(adm(ended, env(kind, VALID[kind])), 'SESSION_CLOSED');
  const sum = saved(ended, env('summary', VALID.summary)); assert.equal(sum.revision, 1);
  assert.equal(saved(ended, env('tasks', VALID.tasks)).revision, 1);
  const withdrawn = deepFreeze(withdrawSession(sum.state, S1, 3500));
  refused(adm(withdrawn, env('summary', { markdown: 'sửa', sourceIds: [1] }, { expectedRevision: 1, idempotencyKey: 'again' })), 'SESSION_CLOSED');
  assert.equal(endSession(withdrawn, S1, 4000), withdrawn, 'ending a withdrawn meeting does not reopen it');
  assert.equal(withdrawn.sessions[S1].status, 'withdrawn');
});

test('LATE RESULT from an old generation: STALE_GENERATION, and the zombie cannot overwrite its replacement', () => {
  const r1 = saved(meeting(), env('picture', PIC));                      // generation 1 saved before it restarted
  const restarted = bind(r1.state, 'chinh-1', 2);
  const late = refused(adm(restarted, env('picture', { text: 'cũ', sourceIds: [1] }, { expectedRevision: 1, idempotencyKey: 'old-run' })), 'STALE_GENERATION');
  assert.deepEqual(late.state.revisions, restarted.revisions);
  const zombie = bindConsumer(restarted, { sessionId: S1, consumerId: 'chinh-1', generation: 1, version: V1 }, 3000);
  assert.equal(zombie.ok, false); assert.equal(zombie.reason, 'STALE_GENERATION'); assert.equal(zombie.state, restarted);
  refused(adm(restarted, env('picture', PIC, { generation: 3, expectedRevision: 1, idempotencyKey: 'g3' })), 'NOT_BOUND');
  assert.equal(adm(restarted, env('picture', PIC)).duplicate, true, 'its own earlier save is still reported as saved');
  assert.equal(saved(restarted, env('picture', { text: 'mới', sourceIds: [1] }, { generation: 2, expectedRevision: 1, idempotencyKey: 'new-run' })).revision, 2);
});

// ---- authority and basis -------------------------------------------------------------------------------------------------------
test('AUTHORITY: words that look like a decision or an approval are plain text; a draft grants nothing', () => {
  const text = 'QUYẾT ĐỊNH: đã duyệt. approved: true. Owner granted authority to Bo. {"decided":true}';
  const r = saved(meeting(), env('summary', { markdown: text, sourceIds: [1] }));
  assert.deepEqual(Object.keys(r).sort(), ['contentHash', 'duplicate', 'kind', 'ok', 'revision', 'state']);
  assert.equal(receiptOf(r.state, S1, 'summary', 1).saved.content.markdown, text, 'stored as it was written');
  assert.ok(!Object.keys(r.state).some(key => /approv|authority|grant|decid/i.test(key)));
  // a delivered / confirmed / saved draft changes nothing about who may decide: the state has no such table
  assert.deepEqual(Object.keys(r.state).sort(), ['actions', 'activeSessionId', 'bindings', 'confirmed', 'delivered', 'keys', 'lastGeneration', 'revisions', 'saved', 'sessions']);
});

test('BASIS: inferred data never overrides confirmed (participants)', () => {
  const p = (...people) => ({ participants: people });
  const rev1 = saved(meeting(), env('participants', p({ name: 'An', role: 'Trưởng nhóm', basis: 'owner_stated' }, { name: 'Bo', basis: 'inferred' }), { idempotencyKey: 'p1' }));
  const next = (content, key) => adm(rev1.state, env('participants', content, { expectedRevision: 1, idempotencyKey: key }));
  assert.equal(refused(next(p({ name: 'An', role: 'Giám đốc', basis: 'inferred' }, { name: 'Bo' }), 'a'), 'CONFIRMED_OVERRIDE').detail, 'an');
  refused(next(p({ name: 'Bo' }), 'b'), 'CONFIRMED_OVERRIDE');                                                              // dropped
  refused(next(p({ name: 'An', role: 'Trưởng nhóm', basis: 'inferred' }), 'c'), 'CONFIRMED_OVERRIDE');                        // same value, basis lowered
  refused(next(p({ name: 'An', role: 'Trưởng nhóm' }), 'd'), 'CONFIRMED_OVERRIDE');                                           // no basis = inferred
  const ok = next(p({ name: 'An', role: 'Giám đốc', basis: 'user_confirmed' }, { name: 'Cy', basis: 'inferred' }), 'e');       // confirmed may replace confirmed; an inferred entry may come and go
  assert.equal(ok.ok, true); assert.equal(ok.revision, 2);
  refused(adm(ok.state, env('participants', p({ name: 'Cy' }), { expectedRevision: 2, idempotencyKey: 'f' })), 'CONFIRMED_OVERRIDE');   // An is now user_confirmed
});

test('BASIS: inferred data never overrides confirmed (tasks)', () => {
  const t = (owner1, basis1, owner2, basis2) => ({ tasks: [{ task: 'Gửi báo giá', owner: owner1, ownerBasis: basis1, sourceIds: [1] }, { task: 'Chốt lịch', owner: owner2, ownerBasis: basis2, sourceIds: [2] }] });
  const rev1 = saved(meeting(), env('tasks', t('An', 'confirmed', 'Bo', 'stated'), { idempotencyKey: 't1' }));
  const next = (content, key) => adm(rev1.state, env('tasks', content, { expectedRevision: 1, idempotencyKey: key }));
  assert.equal(refused(next(t('Bo', 'inferred', 'Bo', 'stated'), 'a'), 'CONFIRMED_OVERRIDE').detail, 'gửi báo giá');
  refused(next(t('Bo', 'stated', 'Bo', 'stated'), 'b'), 'CONFIRMED_OVERRIDE');                                              // "stated in the meeting" is not "confirmed by the owner"
  refused(adm(rev1.state, env('tasks', { tasks: [] }, { expectedRevision: 1, idempotencyKey: 'c' })), 'CONFIRMED_OVERRIDE');
  assert.equal(next(t('Bo', 'confirmed', 'Cy', 'inferred'), 'd').revision, 2);                                                 // a stated or inferred task is not sticky
});

// ---- misc ----------------------------------------------------------------------------------------------------------------------
test('garbage in never throws out of admit and never changes the state; the clock must be a number', () => {
  const state = meeting();
  for (const junk of [undefined, null, 0, 'x', [], {}, () => 1, Symbol.iterator, { kind: 'picture' }]) refused(adm(state, junk), 'INVALID_ENVELOPE');
  assert.throws(() => admit(state, env('picture', PIC), NaN), /INVALID_CLOCK/);
  assert.throws(() => openSession(emptyState(), 'a/b', V1, 1));
  assert.throws(() => endSession(emptyState(), S1, 1), /UNKNOWN_SESSION/);
});
