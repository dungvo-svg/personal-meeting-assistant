// 0.13.0 item 7 (clock-injected, no real waiting) and item 6 (the validator itself).
import assert from 'node:assert/strict';
import { test, withFakes, openSession } from './fakes.mjs';
import { validateDraft } from '../dist/drafts.js';

test('translate and picture accept a meeting that ended within the grace period and refuse it after; recentSessionId follows the same limit', async () => {
  await withFakes(async (r, dir) => {
    const { id } = await openSession(r, dir, 'OTC');
    const wall = new Date(Date.now() - 20000).toISOString();
    const lao = r.ingest('ສະບາຍດີ', 'local_asr_unverified', 0, 3, '', 'cap', 'lo', wall, 1);
    assert.equal(r.recentSessionId(), id, 'the open meeting');
    await r.finish(id);
    const endedAt = Date.parse(r.session.ended); assert.equal(r.graceMs, 10 * 60000, 'ten minutes');
    // 23/11: the background translator's last save came after `pma stop` and got NO_OPEN_SESSION (14 rows untranslated).
    r.now = () => endedAt + 9 * 60000;
    assert.equal(r.recentSessionId(), id);
    assert.equal(r.translate(id, [{ sourceId: lao, text: 'Xin chào' }]).saved, 1);
    assert.equal(r.savePicture(id, 'Bức tranh muộn.', [lao], { expectedRevision: 0 }).revision, 1);
    // A kind that is not a draft of the translator/picture stays closed: the glossary-style "manual" line, a note.
    assert.throws(() => r.publish(id, 'k', 1, 'observation', 'x', [lao]), /SESSION_NOT_ACTIVE/);
    // After the grace period the refusal is the old one.
    r.now = () => endedAt + 10 * 60000 + 1000;
    assert.equal(r.recentSessionId(), null);
    assert.throws(() => r.translate(id, [{ sourceId: lao, text: 'Xin chào lại' }]), /SESSION_NOT_ACTIVE/);
    assert.throws(() => r.savePicture(id, 'Bức tranh quá muộn.', [lao], { expectedRevision: 1 }), /SESSION_NOT_ACTIVE/);
    // The grace period is tunable (a test or a later decision), not a magic number inside the check.
    r.graceMs = 20 * 60000; assert.equal(r.recentSessionId(), id);
    assert.throws(() => r.translate('00000000-0000-4000-8000-000000000000', [{ sourceId: lao, text: 'x' }]), /SESSION_NOT_ACTIVE/, 'an unknown meeting is never accepted');
  });
});

test('participants: an empty or blank role is no role; a role that is too long or not a string is still refused', () => {
  const ok = validateDraft('participants', { participants: [{ name: 'An', role: '' }, { name: 'Bình', role: '   ' }, { name: 'Chi', role: ' Kế toán ' }] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.content.participants.map(p => [p.name, 'role' in p ? p.role : '(none)']), [['An', '(none)'], ['Bình', '(none)'], ['Chi', 'Kế toán']]);
  assert.equal(validateDraft('participants', { participants: [{ name: 'An', role: 'x'.repeat(121) }] }).code, 'BAD_LENGTH');
  assert.equal(validateDraft('participants', { participants: [{ name: 'An', role: 5 }] }).code, 'NOT_A_STRING');
  assert.equal(validateDraft('participants', { participants: [{ name: '', role: '' }] }).code, 'BAD_LENGTH', 'the name is still required');
  // The same blank-is-absent rule for the optional owner and due of a task ("để trống owner" in the guide).
  const tasks = validateDraft('tasks', { tasks: [{ task: 'Gửi giá', owner: '', due: ' ', sourceIds: [1] }] });
  assert.equal(tasks.ok, true); assert.deepEqual(tasks.content.tasks[0], { task: 'Gửi giá', sourceIds: [1] });
  // Same content with and without the blank role is the same draft (idempotency by hash).
  assert.equal(validateDraft('participants', { participants: [{ name: 'An', role: '' }] }).contentHash, validateDraft('participants', { participants: [{ name: 'An' }] }).contentHash);
});
