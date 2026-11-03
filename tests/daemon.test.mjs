import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { applyEnv, isolatedEnv, recordingHost, teardown } from './harness.mjs';

const run = promisify(execFile);
// A world of its own (temp root, data dir, lock dir, free port, no inherited PMA_*): the host started below can never be the user's.
const world = await isolatedEnv('daemon');
const env = world.env; const directory = env.PMA_DATA_DIR;
const restoreEnv = applyEnv(env);   // before the import: client reads them once
const { call, daemonInfo } = await import('../dist/client.js');
const pma = async (...args) => { const { stdout } = await run(process.execPath, [resolve('dist/cli.js'), ...args], { env }); return stdout; };
const json = async (...args) => JSON.parse(await pma(...args));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Stops only a host proven to be this test's own (recorded at start, testMode ping, same pid), then removes the root.
test.after(async () => { await teardown(world); restoreEnv(); });

test('the CLI starts one runtime that outlives the command; a second runtime exits without touching history', async () => {
  // status only looks (0.12.1, ENG-37): with no host it says so and starts none; the next real command starts it.
  const before = await json('status');
  assert.equal(before.host, 'NOT_RUNNING'); assert.equal(daemonInfo(), null);
  await recordingHost(env, () => json('history'));   // starts the host: its pid is recorded as this test's
  const status = await json('status');
  assert.equal(status.session, null);
  const info = daemonInfo();
  await call('prepare', { title: 'Phiên thử', fixture: true });
  const second = spawn(process.execPath, [resolve('dist/daemon.js')], { env, stdio: 'ignore' });
  const code = await new Promise(r => second.on('exit', r));
  assert.equal(code, 1);
  assert.equal(daemonInfo().pid, info.pid);
  assert.equal((await json('status')).session.ended, null);
});

test('RPC needs the local token and rejects browsers', async () => {
  const { url } = daemonInfo();
  const noToken = await fetch(url + '/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'status' }) });
  assert.equal(noToken.status, 401);
  const browser = await fetch(url + '/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url, Authorization: 'Bearer ' + daemonInfo().token }, body: JSON.stringify({ method: 'status' }) });
  assert.equal(browser.status, 401);
  await assert.rejects(call('select', { deviceIndex: -1 }), /INVALID_INPUT/);
  await assert.rejects(call('nope'), /UNKNOWN_METHOD|RPC_FAILED/);
});

test('follow prints batched lines with flags, marks the follower heartbeat and stops when the session ends', async () => {
  const follower = spawn(process.execPath, [resolve('dist/cli.js'), 'follow', '--batch', '1'], { env });
  const exited = new Promise(r => follower.on('exit', r));
  let output = ''; follower.stdout.on('data', d => { output += d; });
  await sleep(1500);
  for (const text of ['Tuần này kiểm kê kho số 2.', 'Anh Nam gửi báo cáo trước thứ Sáu.']) await call('fixture', { text });
  await sleep(2500);
  assert.match(output, /FOLLOWING chinh "Phiên thử"/);
  assert.match(output, /LÔ #1–#2 \(2 đoạn\):\n#1 .*kiểm kê kho số 2\.\n#2 /);
  assert.ok((await json('status')).lastFollowAt);
  const stopped = await json('stop');
  assert.equal(stopped.raw.sourceCount, 2);
  await exited;
  assert.match(output, /KẾT THÚC: phiên đã đóng/);
});

test('after the meeting: read, summary and tasks through the CLI with real source IDs', async () => {
  assert.match(await pma('read'), /#1 .*Tuần này kiểm kê kho số 2\.\n#2 .*\nHẾT/);
  await pma('brief', '--as', 'chinh');   // after the meeting: chinh reads the latest meeting's context before writing its reports
  const summaryFile = join(directory, 'summary.md'); writeFileSync(summaryFile, '- Kiểm kê kho số 2 trong tuần.');
  const summary = await json('summary', '--file', summaryFile, '--sources', '1');
  assert.match(readFileSync(summary.path, 'utf8'), /Kiểm kê kho số 2/);
  const tasksFile = join(directory, 'tasks.json'); writeFileSync(tasksFile, JSON.stringify([{ task: 'Gửi báo cáo', owner: 'Anh Nam', due: 'trước thứ Sáu', sourceIds: [2] }]));
  assert.match(readFileSync((await json('tasks', '--file', tasksFile)).path, 'utf8'), /\| 1 \| Gửi báo cáo \| Anh Nam \| trước thứ Sáu \| #2 \|/);
  const bad = join(directory, 'bad.json'); writeFileSync(bad, JSON.stringify([{ task: 'Bịa', sourceIds: [999] }]));
  assert.match((await run(process.execPath, [resolve('dist/cli.js'), 'tasks', '--file', bad], { env }).catch(e => e)).stdout, /SOURCE_OUTSIDE_SESSION/);
});

test('pma at sets the scheduled start of the current session and rejects bad times', async () => {
  const set = await json('at', '08:15');
  assert.equal(new Date(set.scheduledStart).getHours() * 60 + new Date(set.scheduledStart).getMinutes(), 8 * 60 + 15);
  assert.match(set.coverage, /lịch họp/);
  assert.match((await run(process.execPath, [resolve('dist/cli.js'), 'at', '8h'], { env }).catch(e => e)).stdout, /INVALID_INPUT|INVALID_TIME/);
  assert.equal((await json('context')).agenda.scheduledStart, set.scheduledStart);
});

test('Stop hook: blocks a following session while text is unread, ignores sessions that never followed', async () => {
  await call('prepare', { title: 'Phiên hook', fixture: true });
  await call('fixture', { text: 'Chưa ai đọc đoạn này.' });
  const transcript = join(directory, 'transcript.jsonl');
  const runHook = lines => new Promise((res, rej) => { writeFileSync(transcript, lines.map(l => JSON.stringify(l)).join('\n')); const child = spawn(process.execPath, [resolve('tools/meeting_stop_hook.mjs')], { env: { ...env, PMA_STOP_HOOK: '' } }); let out = ''; child.stdout.on('data', d => { out += d; }); child.on('exit', code => code === 0 ? res(out) : rej(new Error('hook exit ' + code))); child.stdin.end(JSON.stringify({ transcript_path: transcript })); });
  assert.equal(await runHook([{ type: 'text', text: 'chạy ./pma follow nhé' }]), '');
  assert.equal(await runHook([{ type: 'tool_use', name: 'Bash', input: { command: 'export PMA_PORT=1 && ./pma follow' } }]), '');
  const follower = [{ type: 'tool_use', name: 'Bash', input: { command: './pma follow --batch 60' } }];
  assert.match(JSON.parse(await runHook(follower)).reason, /còn 1 đoạn chưa đọc/);
  const { items } = await call('read', {}); await call('next', { after: items.at(-1).id, waitMs: 0 });
  assert.equal(await runHook(follower), '');
  await call('finish');
});

test('follow --as dich keeps its own cursor and never touches the main one; the Stop hook decides per follower', async () => {
  await call('prepare', { title: 'Phiên hai người theo dõi', fixture: true });
  const first = (await call('fixture', { text: 'Đoạn đầu tiên.' })).id;
  await call('next', { after: first, waitMs: 0, follower: true });  // main follower ("chinh") has read #1
  const second = (await call('fixture', { text: 'Đoạn thứ hai.' })).id;
  const before = await json('status');
  assert.equal(before.agentCursor, first); assert.equal(before.followers.chinh.unread, 1);
  const dich = spawn(process.execPath, [resolve('dist/cli.js'), 'follow', '--as', 'dich', '--no-notes', '--batch', '1'], { env });
  const exited = new Promise(r => dich.on('exit', r));
  let output = ''; dich.stdout.on('data', d => { output += d; });
  await sleep(2500);
  assert.match(output, new RegExp(`FOLLOWING dich "Phiên hai người theo dõi" từ #${first} `));
  assert.match(output, new RegExp(`#${second} .*Đoạn thứ hai\\.`));
  const mid = await json('status');
  assert.equal(mid.agentCursor, first); assert.equal(mid.unread, 1); assert.equal(mid.lastFollowAt === before.lastFollowAt, true);
  assert.equal(mid.followers.dich.cursor, second); assert.equal(mid.followers.dich.unread, 0);
  assert.equal(mid.followers.chinh.cursor, first); assert.equal(mid.followers.chinh.unread, 1);

  const transcript = join(directory, 'transcript-follow.jsonl');
  const runHook = lines => new Promise((res, rej) => { writeFileSync(transcript, lines.map(l => JSON.stringify(l)).join('\n')); const child = spawn(process.execPath, [resolve('tools/meeting_stop_hook.mjs')], { env: { ...env, PMA_STOP_HOOK: '' } }); let out = ''; child.stdout.on('data', d => { out += d; }); child.on('exit', code => code === 0 ? res(out) : rej(new Error('hook exit ' + code))); child.stdin.end(JSON.stringify({ transcript_path: transcript })); });
  const bash = command => ({ type: 'tool_use', name: 'Bash', input: { command } });
  const asDich = bash('./pma follow --batch 15 --as dich --no-notes'), asMain = bash('./pma follow --batch 60');
  // The dich session has read everything: nothing to block on. The main session still has #2 unread.
  assert.equal(await runHook([asDich]), '');
  const blocked = JSON.parse(await runHook([asMain])).reason;
  assert.match(blocked, /còn 1 đoạn chưa đọc/); assert.match(blocked, new RegExp(`--after ${first}\``));
  // The last `--as` in the transcript decides.
  assert.equal(await runHook([asMain, asDich]), '');
  assert.match(JSON.parse(await runHook([asDich, asMain])).reason, /còn 1 đoạn chưa đọc/);
  // dich stops following and text arrives: block, naming the follower and its own cursor.
  dich.kill(); await exited;
  await call('fixture', { text: 'Đoạn thứ ba.' });
  const behind = (await json('status')).followers.dich;
  assert.equal(behind.unread, 1); assert.equal(behind.cursor, second);
  const reason = JSON.parse(await runHook([bash('./pma follow --as dich')])).reason;
  // the share role is sent to its own filtered read, never the owner's full one
  assert.match(reason, /người theo dõi "dich"/); assert.match(reason, new RegExp(`\`./pma read --as dich --after ${second}\``));
  await call('finish');
});

test('pma translate saves a Claude translation for a Lao segment and refuses Vietnamese ones', async () => {
  await call('prepare', { title: 'Phiên dịch', fixture: true });
  const vi = (await call('fixture', { text: 'Kho số hai đủ hàng.', language: 'vi' })).id;
  const lo = (await call('fixture', { text: 'ສະບາຍດີທຸກຄົນ', language: 'lo' })).id;
  assert.match(await pma('translate', '--source', String(lo), '--text', 'Xin chào mọi người.'), /"saved":1/);
  const bad = await run(process.execPath, [resolve('dist/cli.js'), 'translate', '--source', String(vi), '--text', 'x'], { env }).catch(e => e);
  assert.match(bad.stdout, /TRANSLATE_ONLY_LAO/);
  await call('finish');
});

test('no web panel: every path other than /rpc is a 404, with or without a cookie', async () => {
  const { url } = daemonInfo();
  for (const path of ['/live', '/', '/api/state', '/api/events', '/api/manual', '/index.html']) {
    const reply = await fetch(url + path); assert.equal(reply.status, 404, path); assert.equal((await reply.json()).error, 'NOT_FOUND');
    assert.equal(reply.headers.get('set-cookie'), null, path);
  }
  const post = await fetch(url + '/api/manual', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url, Cookie: 'pma=x' }, body: JSON.stringify({ text: 'x' }) });
  assert.equal(post.status, 404);
});

test('manual text: `pma say` ingests operator_text, RAW shows "nhập tay", bad input is refused', async () => {
  await assert.rejects(call('manual', { text: 'chưa có phiên' }), /INVALID_INPUT|SESSION/);
  await call('prepare', { title: 'Phiên nhập tay', fixture: true });
  const said = await json('say', '--text', '  Anh Nam báo kho số 3 hết hàng.  ');
  assert.ok(said.id > 0);
  const via = await call('manual', { text: 'Chị Lan xác nhận lại sau.' });
  assert.equal(via.id, said.id + 1);
  const { items } = await call('read', {});
  assert.deepEqual(items.map(i => [i.origin, i.text]), [['operator_text', 'Anh Nam báo kho số 3 hết hàng.'], ['operator_text', 'Chị Lan xác nhận lại sau.']]);
  assert.ok(items.every(i => !i.language));
  for (const text of ['', '   ', 'x'.repeat(8001), 5, undefined]) await assert.rejects(call('manual', { text }), /INVALID_INPUT/, JSON.stringify(text)?.slice(0, 30));
  await assert.rejects(call('manual', { sessionId: '00000000-0000-4000-8000-000000000000', text: 'phiên lạ' }), /SESSION|INVALID/);
  assert.equal((await call('manual', { text: 'x'.repeat(8000) })).id > via.id, true);
  assert.match((await run(process.execPath, [resolve('dist/cli.js'), 'say'], { env }).catch(e => e)).stdout, /INVALID_INPUT/);
  const finished = await call('finish');
  const raw = readFileSync(finished.raw.path, 'utf8');
  assert.match(raw, /nhập tay/); assert.match(raw, /Anh Nam báo kho số 3 hết hàng\./);
  await assert.rejects(call('manual', { text: 'sau khi đóng' }), /SESSION_NOT_ACTIVE|SESSION|INVALID/);
});

test('Stop hook: no daemon.json means allow; a live-looking session with nobody following means block', async () => {
  const run1 = (dataDir, lines) => new Promise((res, rej) => {
    const transcript = join(directory, 'transcript-nodaemon.jsonl'); writeFileSync(transcript, lines.map(l => JSON.stringify(l)).join('\n'));
    const child = spawn(process.execPath, [resolve('tools/meeting_stop_hook.mjs')], { env: { ...env, PMA_STOP_HOOK: '', PMA_DATA_DIR: dataDir } });
    let out = ''; child.stdout.on('data', d => { out += d; }); child.on('exit', code => code === 0 ? res(out) : rej(new Error('hook exit ' + code))); child.stdin.end(JSON.stringify({ transcript_path: transcript }));
  });
  const follower = [{ type: 'tool_use', name: 'Bash', input: { command: './pma follow --batch 60' } }];
  const empty = mkdtempSync(join(world.root, 'hook-empty-'));
  try {
    assert.equal(await run1(empty, follower), '');
    // The retired panel.json is no longer a fallback: a lone panel.json does not make the hook query anything.
    writeFileSync(join(empty, 'panel.json'), JSON.stringify({ url: daemonInfo().url }));
    assert.equal(await run1(empty, follower), '');
  } finally { world.cleanup(empty); }
  // A fake host that looks live (LISTENING, 3 unread) and is not followed: block. A fresh heartbeat of the main follower: allow.
  let status = { session: { title: 'Phiên giả đang họp', ended: null }, captureState: 'LISTENING', unread: 3, agentCursor: 0, lastFollowAt: null, followers: {} };
  const fake = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, result: status })); }); });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const fakeDir = mkdtempSync(join(world.root, 'hook-fake-'));
  try {
    writeFileSync(join(fakeDir, 'daemon.json'), JSON.stringify({ url: 'http://127.0.0.1:' + fake.address().port, token: 'fake' }));
    const reason = JSON.parse(await run1(fakeDir, follower)).reason;
    assert.match(reason, /Phiên giả đang họp/); assert.match(reason, /đang diễn ra \(LISTENING, 3 đoạn chưa đọc\) mà không có ai theo dõi/);
    status = { ...status, lastFollowAt: new Date().toISOString() };
    assert.equal(await run1(fakeDir, follower), '');
    status = { ...status, lastFollowAt: null, session: { ...status.session, ended: new Date().toISOString() } };
    assert.equal(await run1(fakeDir, follower), '');
  } finally { fake.close(); world.cleanup(fakeDir); }
});
