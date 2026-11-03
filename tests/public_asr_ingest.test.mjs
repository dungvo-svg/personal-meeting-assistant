// Public ASR output through an isolated candidate host (Stage B, 03/11): the one line the candidate's offline ASR produced from the
// PUBLIC clip FLEURS vi_vn test row 0 (Codex run on 224b9a9, CPU small, artifact pma-vi-cpu-public-20261103T181644Z, RAW.md sha256
// 0d60e9f3d8d79afe151bd9f5c8116fc6be70776b42f0db9774191d04634e6bf7) goes into a diagnostic host of this test's own world as a source
// row, and from there into the real persistence: a reference correction kept apart from the raw text, a context receipt, the meeting
// picture with that source id, RAW.md and SUMMARY.md. No ASR runs here (the line is the recorded output, verbatim), no device, no
// model, no audio; harness.mjs world (temp root/data/lock, private port, PMA_TEST_MODE=1, PMA_WARM=0), read-only bootstrap, every
// change through the harness proof, cleanup confirmed. Labelled everywhere as a public fixture, NOT a meeting; the row's origin is
// synthetic_fixture (the host's fixture door), not local ASR of a live source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyEnv, assertCleaned, guardedCall, isolatedEnv, recordingHost, teardown } from './harness.mjs';

const RAW_ASR = 'Văn hóa và bộ lạc cổ xưa đã bắt đầu giữ những con bật này để dễ lấy sữa tóc, thịt và da.';
const LABEL = 'FIXTURE CÔNG KHAI FLEURS vi_vn test #0 (CC-BY-4.0), không phải cuộc họp';

test('public ASR line → isolated host source row → reference correction kept apart → receipt → picture, RAW and SUMMARY', async () => {
  const world = await isolatedEnv('public-asr'); const restoreEnv = applyEnv(world.env);
  const { call } = await import('../dist/client.js');
  try {
    await recordingHost(world.env, () => call('history')); const owned = guardedCall(world.env);
    const opened = await owned('prepare', { title: LABEL, fixture: true, languages: ['vi'] }); const sessionId = opened.session.id;
    const sourceId = (await owned('fixture', { text: RAW_ASR, language: 'vi' })).id;

    // The row is the ASR output exactly: "bật" stays (the dataset reference says "vật"; that is not the owner's word).
    const { items } = await owned('read', { sessionId });
    assert.equal(items.length, 1); assert.equal(items[0].id, sourceId); assert.equal(items[0].text, RAW_ASR); assert.equal(items[0].origin, 'synthetic_fixture');

    // The dataset reference goes in as an INFERRED correction tied to the row; the row itself is not rewritten.
    const corrected = await owned('correct', { sessionId, raw: 'bật', corrected: 'vật', sourceId, basis: 'inferred', scope: 'meeting' });
    assert.ok(corrected.version && corrected.corrections === 1);
    assert.equal((await owned('read', { sessionId })).items[0].text, RAW_ASR, 'a correction never replaces the raw text');

    // The central draft needs the receipt of a read of THIS context (after the correction) and the base revision.
    const { receipt, markdown } = await owned('brief', { sessionId, as: 'chinh' });
    assert.match(receipt, /^rcpt-[a-f0-9]{16}$/); assert.match(markdown, /"bật" → "vật" \(suy luận, cuộc họp này, nguồn #\d+\)/);
    const picture = await owned('picture', { sessionId, text: `${LABEL}. Một câu tiếng Việt về văn hóa và bộ lạc cổ xưa nuôi động vật để lấy sữa, thịt và da [#${sourceId}]. Không có người nói, quyết định hay việc.`, sourceIds: [sourceId], receipt, expectedRevision: 0 });
    assert.equal(picture.revision, 1); assert.equal(picture.receipt.state, 'SAVED');

    const finished = await owned('finish', { sessionId });
    const raw = readFileSync(finished.raw.path, 'utf8');
    assert.ok(raw.includes(RAW_ASR), 'RAW.md carries the ASR line verbatim'); assert.match(raw, /FIXTURE CÔNG KHAI/);

    const summary = await owned('summary', { sessionId, markdown: `- ${LABEL}.\n- Một câu, nguồn #${sourceId}; chữ "bật" là máy nghe, bản tham chiếu của bộ dữ liệu ghi "vật" (suy luận, chưa ai xác nhận).`, sourceIds: [sourceId], receipt, expectedRevision: 0 });
    assert.equal(summary.revision, 1); assert.equal(summary.scope, 'LOCAL_FILE_ONLY_NOT_SENT');
    const text = readFileSync(summary.path, 'utf8');
    assert.match(text, /Không phải biên bản đã được duyệt/); assert.match(text, new RegExp(`nguồn #${sourceId}`));
  } finally {
    try { assertCleaned(await teardown(world)); } finally { restoreEnv(); }
  }
});
