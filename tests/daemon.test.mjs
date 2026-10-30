import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const directory = mkdtempSync(join(tmpdir(), 'pma-daemon-test-'));
const env = { ...process.env, PMA_PORT: process.env.PMA_TEST_PORT || '8798', PMA_TEST_MODE: '1', PMA_DATA_DIR: directory, PMA_STOP_HOOK: 'off' };
Object.assign(process.env, env);
const { call, daemonInfo } = await import('../dist/client.js');
const pma = async (...args) => { const { stdout } = await run(process.execPath, [resolve('dist/cli.js'), ...args], { env }); return stdout; };
const json = async (...args) => JSON.parse(await pma(...args));
const sleep = ms => new Promise(r => setTimeout(r, ms));

test.after(async () => { await call('shutdown').catch(() => {}); await sleep(500); rmSync(directory, { recursive: true, force: true }); });

test('the CLI starts one runtime that outlives the command; a second runtime exits without touching history', async () => {
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
  assert.match(reason, /người theo dõi "dich"/); assert.match(reason, new RegExp(`--after ${second}\``));
  await call('finish');
});

test('pma translate saves a Claude translation for a Lao segment and refuses Vietnamese ones', async () => {
  await call('prepare', { title: 'Phiên dịch', fixture: true });
  const vi = (await call('fixture', { text: 'Kho số hai đủ hàng.', language: 'vi' })).id;
  const lo = (await call('fixture', { text: 'ສະບາຍດີທຸກຄົນ', language: 'lo' })).id;
  assert.match(await pma('translate', '--source', String(lo), '--text', 'Xin chào mọi người.'), /"saved":1/);
  const bad = await run(process.execPath, [resolve('dist/cli.js'), 'translate', '--source', String(vi), '--text', 'x'], { env }).catch(e => e);
  assert.match(bad.stdout, /TRANSLATE_ONLY_LAO/);
  assert.equal((await fetch(daemonInfo().url + '/live')).status, 403);
  await call('finish');
});
