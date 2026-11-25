// The meeting is anchored where the owner starts it and where the owner ends it (OWN-015, OWN-022, OWN-028; audit of 10/11): nothing
// in the tool ends it, gives up on it or drops audio from it silently. Fakes only (tests/fakes.mjs): node scripts as recorder and worker,
// temp folders, no device, no model, no real host. The only processes signalled are the fakes these tests started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openSession, readLog, sleep, until, withFakes } from './fakes.mjs';
import { MeetingRuntime } from '../dist/runtime.js';

const spawns = (audio, name) => readLog(audio, name).filter(e => e.what === 'spawn');
const after = (argv, flag) => argv[argv.indexOf(flag) + 1];
const identity = pid => 'fake-start-' + pid;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('T5: the ASR worker keeps dying: past 3 restarts it is still tried again (slower, loud error), never given up while the meeting is open', async () => {
  await withFakes(async (r, dir) => {
    const { id, audio } = await openSession(r, dir);
    writeFileSync(join(audio, 'crash-worker'), 'always');
    await r.start(id);
    await until(() => spawns(audio, 'worker-log.jsonl').length >= 6, 'restarts go on past the 4th crash');
    assert.match(r.lastError, /vẫn thử lại mỗi/); assert.match(r.lastError, /boom/);
    assert.notEqual(r.captureState, 'ERROR'); assert.equal(r.registry().asr, 'listening', 'the owner still wants the ASR'); assert.equal(r.recorder.state, 'RECORDING');
    rmSync(join(audio, 'crash-worker'));
    await until(() => r.captureState === 'LISTENING', 'listening again without any command');
  });
});

test('T4: a worker that reads to an end while the recorder still records is started again, with no gap and no skip', async () => {
  await withFakes(async (r, dir) => {
    const { id, audio } = await openSession(r, dir);
    writeFileSync(join(audio, 'exit0-worker'), '');
    await r.start(id);
    await until(() => spawns(audio, 'worker-log.jsonl').length === 2 && r.captureState === 'LISTENING', 'the ASR follows the recording again');
    assert.equal(r.registry().asr, 'listening');
    assert.equal(r.sources(id).filter(row => row.origin === 'system_gap').length, 0, 'nothing was lost, so no gap row');
  });
});

test('K4: a hung worker is restarted by the stall check and resumes exactly where the text got to (no 10 s skip, no gap row)', async () => {
  await withFakes(async (r, dir) => {
    const { id, audio } = await openSession(r, dir);
    writeFileSync(join(audio, 'hang-worker'), '');
    await r.start(id);
    await until(() => r.captureState === 'LISTENING' && r.sources(id).length === 1, 'first text, then silence');
    const position = r.compact().asr.position;
    r.stallSeconds = 0.2; await sleep(400); r.stallCheck();
    await until(() => spawns(audio, 'worker-log.jsonl').length === 2, 'started again');
    assert.equal(after(spawns(audio, 'worker-log.jsonl')[1].argv, '--from-wall'), position, 'from the ASR position itself');
    assert.match(r.lastError, /Bộ nghe đứng/); assert.match(r.lastError, /không bỏ đoạn nào/);
    assert.equal(r.sources(id).filter(row => row.origin === 'system_gap').length, 0);
    assert.equal(r.compact().asr.restarts, 0, 'a stall is not counted as a crash');
    assert.ok(readLog(audio, 'asr-log.jsonl').some(e => e.type === 'stall'), 'the stall is in the ASR log beside the WAV');
    assert.ok(!readLog(audio, 'asr-log.jsonl').some(e => e.type === 'source'), 'the log never holds the text');
  });
});

test('T2 + T3: shutting the host down keeps the meeting; the next host takes it over; a recorder that ends "interrupted" is restarted, not finished', async () => {
  await withFakes(async (r, dir, root) => {
    const { id, audio } = await openSession(r, dir); const pid = r.recorder.pid;
    await r.close({ keepMeeting: true });
    assert.equal(r.session.ended, null, 'not ended by a shutdown'); assert.ok(alive(pid), 'the recorder records on');
    const takeover = JSON.parse(readFileSync(join(dir, 'takeover.json'), 'utf8')); assert.equal(takeover.sessionId, id); assert.equal(takeover.recorderPid, pid);
    const next = new MeetingRuntime(root, dir, false, undefined, { startedAt: identity }); next.restartDelayMs = 30; next.mixer = () => {};
    try {
      assert.equal(next.session?.id, id, 'the meeting is taken over'); assert.equal(next.recorder.attached, true); assert.equal(existsSync(join(dir, 'takeover.json')), false);
      // The recorder fails: its own end says why (not a stop of the owner). The meeting must go on with a new recorder run.
      appendFileSync(join(audio, 'timeline.jsonl'), JSON.stringify({ t: new Date().toISOString(), type: 'end', reason: 'interrupted' }) + '\n');
      process.kill(pid);
      await until(() => spawns(audio, 'recorder-log.jsonl').length === 2 && next.recorder.state === 'RECORDING', 'recording again', 10000);
      assert.equal(next.session.ended, null, 'an "interrupted" end does not finish the meeting');
      await next.finish(id);
      assert.ok(next.session.ended, 'the owner ends it');
    } finally { await next.close(); }
  }, { startedAt: identity });
});

test('recheck: a long range is cut into pieces of at most 5 minutes, in the form it came in', async () => {
  const { pieces } = await import('../dist/ranges.js');
  assert.deepEqual(pieces('09:16:50', '09:26:37', 300), [['09:16:50', '09:21:50'], ['09:21:50', '09:26:37']]);
  assert.equal(pieces('08:24:27', '08:44:27', 300).length, 4);
  assert.deepEqual(pieces('23:58:00', '00:03:00', 300), [['23:58:00', '00:03:00']], 'past midnight it rolls on');
  assert.deepEqual(pieces('10:00', '10:00', 300), [['10:00', '10:00']], 'an empty range goes through whole, for the host to refuse');
  assert.deepEqual(pieces('2026-11-10T01:24:30.000Z', '2026-11-10T01:31:00.000Z', 300), [['2026-11-10T01:24:30.000Z', '2026-11-10T01:29:30.000Z'], ['2026-11-10T01:29:30.000Z', '2026-11-10T01:31:00.000Z']]);
});

test('C1: a one-word name variant is taken only as written: "quân y" stays, "Quân" is the person', async () => {
  const { applyGlossary } = await import('../dist/text.js');
  const glossary = [{ name: 'Hoàng Văn Quân', variants: ['Quân'] }, { name: 'MISA', variants: ['mì da'] }];
  assert.equal(applyGlossary('bên quân y nói', glossary), 'bên quân y nói');
  assert.equal(applyGlossary('anh Quân nói', glossary), 'anh Hoàng Văn Quân (nghe: Quân) nói');
  assert.equal(applyGlossary('Mì da báo lỗi', glossary), 'MISA (nghe: Mì da) báo lỗi', 'several words still match any case');
});

test('glossary short forms ("Trang" of "Hoàng Thị Thu Trang") expand only for people of this meeting (real meeting 25/11)', async () => {
  const { applyGlossary, isShortFormOf } = await import('../dist/text.js');
  // A machine-wide glossary with names from other meetings (as on 25/11); the sentences are made up, the way the real ones went wrong.
  const glossary = [{ name: 'Hoàng Thị Thu Trang', variants: ['Trang'] }, { name: 'Hoàng Nam Quốc', variants: ['Quốc'] }, { name: 'Hoàng Khánh Linh', variants: ['Linh'] },
    { name: 'Hoàng Văn Quân (Khounkham)', variants: ['Quân'] }, { name: 'Claude', variants: ['Cloudy'] }, { name: 'Namfon', variants: ['Nam Phủ'] }];
  const meeting = new Set(['dũng', 'khounkham', 'lan phạm', 'trang hoàng', 'quân']);  // a meeting's context, nickname "Quân" → of "Khounkham"
  assert.equal(applyGlossary('chiều nay Trang gửi bảng giá', glossary, meeting), 'chiều nay Trang gửi bảng giá', 'another Trang is in the room');
  assert.equal(applyGlossary('bên cô Quốc đã nhận hàng', glossary, meeting), 'bên cô Quốc đã nhận hàng');
  assert.equal(applyGlossary('Linh xem giúp số này', glossary, meeting), 'Linh xem giúp số này');
  // A short form of someone who IS in this meeting is still expanded; "Hoàng Văn Quân (Khounkham)" is in it through "Khounkham".
  assert.equal(applyGlossary('anh Quân nói', glossary, meeting), 'anh Hoàng Văn Quân (Khounkham) (nghe: Quân) nói');
  assert.equal(applyGlossary('chị Trang nói', glossary, new Set(['hoàng thị thu trang'])), 'chị Hoàng Thị Thu Trang (nghe: Trang) nói');
  // Misheard spellings that are not a word of the name are untouched by the rule.
  assert.equal(applyGlossary('Cloudy làm, Nam Phủ duyệt', glossary, meeting), 'Claude (nghe: Cloudy) làm, Namfon (nghe: Nam Phủ) duyệt');
  // Without a meeting (no `present`) the old behaviour stays.
  assert.equal(applyGlossary('chị Trang nói', glossary), 'chị Hoàng Thị Thu Trang (nghe: Trang) nói');
  assert.equal(isShortFormOf('Trang', 'Hoàng Thị Thu Trang'), true);
  assert.equal(isShortFormOf('Cloudy', 'Claude'), false);
  assert.equal(isShortFormOf('Phương Anh', 'Nguyễn Phương Anh'), false, 'a two-word form is not a one-word given name');
});

test('coverage pages through every item (it used to stop at 200)', async () => {
  await withFakes(async (r, dir) => {
    const { id } = await openSession(r, dir);
    for (let i = 0; i < 230; i++) r.ingest('đoạn ' + i, 'local_asr_unverified', i, i + 1, 'SILENCE_BOUNDARY_HEURISTIC; LANG_UNSURE', '', 'vi', new Date(Date.now() + i * 2000).toISOString(), 1);
    const first = r.coverage(id, { limit: 200 }); const total = first.total;
    assert.ok(total >= 230); assert.equal(first.items.length, 200); assert.equal(first.next, 200);
    const rest = r.coverage(id, { after: first.next }); assert.equal(first.items.length + rest.items.length, total); assert.equal(rest.next, null);
  });
});

test('pma guide prints the procedure of this installed tool with its full path, and the translator part on its own', () => {
  const cli = join(import.meta.dirname, '..', 'dist', 'cli.js');
  const all = execFileSync(process.execPath, [cli, 'guide'], { encoding: 'utf8' }); const dich = execFileSync(process.execPath, [cli, 'guide', 'dich'], { encoding: 'utf8' });
  assert.match(all, /^<!-- pma \d+\.\d+\.\d+ · /); assert.doesNotMatch(all, /\{\{|\.\/pma /, 'no placeholder and no relative ./pma left');
  assert.match(all, /"[A-Za-z]:\/[^"]*\/pma" status/); assert.match(dich, /## Brief agent dịch nền/); assert.doesNotMatch(dich, /## Đọc dòng transcript/);
  const skill = readFileSync(join(import.meta.dirname, '..', '.claude', 'skills', 'hop', 'SKILL.md'), 'utf8');
  assert.match(skill, /pma" guide/); assert.ok(skill.length < 2000, 'the skill only points to the tool');
});
