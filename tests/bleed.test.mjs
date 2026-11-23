// Speaker sound leaking into the owner's mic (0.13): the host compares a mic row with the speaker rows of the same moment, flags a
// leak with the matching row, renders it as leaked speaker sound (not "Tôi") and keeps it away from share roles. Synthetic text only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { MeetingRuntime } from '../dist/runtime.js';
import { bleedOf, textOverlap, normalizeText } from '../dist/bleed.js';
import { micLabel, shareable } from '../dist/text.js';

const T0 = Date.now() - 50000;   // the host rejects times outside the session
const at = s => new Date(T0 + s * 1000).toISOString();
const row = (id, text, s, seconds, boundary = '') => ({ id, text, wall: at(s), start: 0, end: seconds, boundary });
const MIC = 'CHANNEL_MIC; MIC_STATE_OFF';
const ROOM = 'chúng ta cần chốt báo giá cho gói thầu thuốc trước thứ sáu tuần này';

test('textOverlap: same words in a different case or punctuation overlap fully; unrelated text does not', () => {
  assert.equal(normalizeText('  Chốt, báo GIÁ!  '), 'chốt báo giá');
  assert.ok(textOverlap('Chốt báo giá.', 'chốt báo giá').dice > 0.99);
  assert.ok(textOverlap('hôm nay trời đẹp quá', ROOM).contain < 0.4);
  assert.deepEqual(textOverlap('', ROOM), { contain: 0, dice: 0 });
});

test('a mic row that repeats what the room said at the same time is a leak of that speaker row', () => {
  const speaker = row(10, ROOM, 0, 8);
  const hit = bleedOf(row(11, 'chốt báo giá cho gói thầu thuốc trước thứ sáu', 1, 5, MIC), [speaker]);
  assert.equal(hit?.id, 10); assert.equal(hit?.why, 'TEXT');
});

test('what the owner really says stays the owner', () => {
  const speaker = row(10, ROOM, 0, 8);
  assert.equal(bleedOf(row(11, 'để tôi gửi file excel cho anh Nam chiều nay', 1, 5, MIC), [speaker]), null, 'different words');
  assert.equal(bleedOf(row(12, 'vâng anh', 1, 2, MIC), [speaker]), null, 'too short to compare');
  assert.equal(bleedOf(row(13, 'chốt báo giá cho gói thầu thuốc trước thứ sáu', 40, 5, MIC), [speaker]), null, 'the same words but 30 s later: the owner repeating, not a leak');
  assert.equal(bleedOf(row(14, 'chốt báo giá', 1, 3, MIC), [row(10, ROOM + ' ' + ROOM + ' ' + ROOM, 0, 8)]), null, 'a few words inside a very long room sentence');
  assert.equal(bleedOf(row(15, ROOM, 1, 5, ''), [speaker]), null, 'a row of the speaker channel is never judged');
});

test('weaker overlap counts only with the worker hint MIC_FAINT (mic at its noise floor, room much louder)', () => {
  const speakers = [row(10, 'anh nói là báo giá phải xong', 0, 4), row(11, 'trước thứ sáu nhé các bạn', 4, 3)];
  const partial = 'báo giá phải xong trước thứ sáu và gửi khách hàng';
  assert.equal(bleedOf(row(20, partial, 1, 6, MIC), speakers), null);
  assert.equal(bleedOf(row(21, partial, 1, 6, MIC + '; MIC_FAINT'), speakers)?.why, 'FAINT_TEXT');
});

test('micLabel and shareable: a leak is not "Tôi" and never reaches a share role; text and ordinary mic rows are as before', () => {
  const live = 'SOURCE_LIVE_FOLLOW; MIC_SHARE_OK';
  assert.equal(micLabel(`${MIC}; ${live}`), 'Tôi (mic tắt — nói riêng)');
  const leak = `${MIC}; ${live}; MIC_BLEED #10 TEXT`;
  assert.equal(micLabel(leak, 'Dũng'), 'Tiếng loa lọt vào mic (trùng #10)');
  assert.ok(!micLabel(leak).includes('Tôi'));
  assert.equal(micLabel('CHANNEL_MIC; MIC_STATE_ON; MIC_BLEED_ENV r=0.93'), 'Tiếng loa lọt vào mic', 'the worker flag alone is enough');
  assert.equal(shareable({ origin: 'local_asr_unverified', boundary: 'CHANNEL_MIC; MIC_STATE_ON; MIC_SHARE_OK; SOURCE_LIVE_FOLLOW' }), true);
  assert.equal(shareable({ origin: 'local_asr_unverified', boundary: 'CHANNEL_MIC; MIC_STATE_ON; MIC_SHARE_OK; SOURCE_LIVE_FOLLOW; MIC_BLEED #10 TEXT' }), false);
  assert.equal(shareable({ origin: 'local_asr_unverified', boundary: 'CHANNEL_MIC; MIC_STATE_ON; MIC_SHARE_OK; SOURCE_LIVE_FOLLOW; MIC_BLEED_ENV r=0.9' }), false);
  assert.equal(micLabel('SILENCE_BOUNDARY_HEURISTIC; SOURCE_LIVE_FOLLOW'), null, 'the speaker channel has no mic label');
});

async function withRuntime(fn) {
  const directory = mkdtempSync(join(tmpdir(), 'personal-meeting-bleed-'));
  const runtime = new MeetingRuntime(resolve('.'), directory, true); runtime.mixer = () => {};
  try { await fn(runtime); } finally { await runtime.close(); assert.ok(resolve(directory).startsWith(resolve(tmpdir()))); rmSync(directory, { recursive: true }); }
}

test('the host flags the leak whichever channel is transcribed first; the text stays and a genuine owner row is untouched', async () => {
  await withRuntime(async r => {
    r.prepare('Họp'); const id = r.session.id;
    const hear = (text, s, seconds, boundary, channel) => { r.onWorkerEvent({ type: 'source', text, start: s, end: s + seconds, boundary, language: 'vi', wall: at(s), seg: 1, channel }, true); return r.sources(id).at(-1); };
    // mic first, speaker later
    const leak1 = hear('chốt báo giá cho gói thầu thuốc trước thứ sáu', 1, 5, MIC + '; MIC_SHARE_OK', 'mic');
    const room1 = hear(ROOM, 0, 8, 'SILENCE_BOUNDARY_HEURISTIC', 'speaker');
    // speaker first, mic later
    const room2 = hear('tuần sau mình họp lại với nhà cung cấp về lô hàng mới', 30, 8, 'SILENCE_BOUNDARY_HEURISTIC', 'speaker');
    const leak2 = hear('tuần sau mình họp lại với nhà cung cấp', 31, 5, MIC, 'mic');
    const owner = hear('để tôi gửi file excel cho anh Nam chiều nay nhé', 32, 5, MIC + '; MIC_SHARE_OK', 'mic');
    const flags = Object.fromEntries(r.sources(id).map(s => [s.id, s.boundary]));
    assert.match(flags[leak1.id], new RegExp(`MIC_BLEED #${room1.id} TEXT`));
    assert.match(flags[leak2.id], new RegExp(`MIC_BLEED #${room2.id} TEXT`));
    assert.doesNotMatch(flags[owner.id], /MIC_BLEED/);
    assert.equal(r.sources(id).find(s => s.id === leak1.id).text, 'chốt báo giá cho gói thầu thuốc trước thứ sáu', 'text kept');
    // the share role gets the room, never the leaked copy
    const shared = r.read(id, 0, 100, 'dich').items.map(item => item.id);
    assert.ok(shared.includes(room1.id) && shared.includes(room2.id));
    assert.ok(!shared.includes(leak1.id) && !shared.includes(leak2.id));
  });
});

test('lines cut from one leaked chunk share the verdict, whichever line arrives first', async () => {
  await withRuntime(async r => {
    r.prepare('Họp'); const id = r.session.id;
    const hear = (text, boundary, channel) => { r.onWorkerEvent({ type: 'source', text, start: 1, end: 7, boundary, language: 'vi', wall: at(1), seg: 1, channel }, true); return r.sources(id).at(-1); };
    r.onWorkerEvent({ type: 'source', text: ROOM, start: 0, end: 8, boundary: 'B', language: 'vi', wall: at(0), seg: 1, channel: 'speaker' }, true);
    const first = hear('chốt báo giá cho gói thầu thuốc trước thứ sáu', MIC, 'mic');
    const second = hear('lời khác hẳn của dòng sau', MIC, 'mic');
    const flags = Object.fromEntries(r.sources(id).map(s => [s.id, s.boundary]));
    assert.match(flags[first.id], /MIC_BLEED #\d+ TEXT/); assert.match(flags[second.id], /MIC_BLEED #\d+ CHUNK/);
  });
});

test('a mic row the worker flagged by sound gets the speaker row it overlaps in time as its pointer', async () => {
  await withRuntime(async r => {
    r.prepare('Họp'); const id = r.session.id;
    r.onWorkerEvent({ type: 'source', text: 'tiếng nói khác hẳn', start: 0, end: 6, boundary: 'B', language: 'vi', wall: at(0), seg: 1, channel: 'speaker' }, true);
    r.onWorkerEvent({ type: 'source', text: 'ừm ờ không rõ', start: 1, end: 5, boundary: 'B; CHANNEL_MIC; MIC_STATE_OFF; MIC_BLEED_ENV r=0.93', language: 'vi', wall: at(1), seg: 1, channel: 'mic' }, true);
    const mic = r.sources(id).at(-1); const speaker = r.sources(id)[0];
    assert.match(mic.boundary, new RegExp(`MIC_BLEED #${speaker.id} ENV`));
  });
});
