// `pma follow` and `pma read --as` (plan 0.12 D and A): the built CLI against a scripted stand-in for the host (so the requests it sends can be
// checked), and once against a real test host. Synthetic rows; no audio, no ASR.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttp } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { ackOf } from '../dist/text.js';
import { applyEnv, isolatedEnv, recordingHost, teardown } from './harness.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const LIVE = 'SOURCE_LIVE_FOLLOW'; const MIC = 'CHANNEL_MIC';
const row = (id, text, more = {}) => ({ id, sessionId: 's', text, shown: text, origin: 'local_asr_unverified', start: 0, end: 3, createdAt: '2026-11-01T08:00:00.000Z', boundary: LIVE, captureId: 'c', language: 'vi', wall: '', seg: 1, alternatives: [], ...more });
const status = (more = {}) => ({ session: { id: 's', title: 'Họp thử', ended: null }, captureState: 'LISTENING', agentCursor: 0, followers: {}, recorder: {}, captureInfo: {}, ...more });
const reply = (items, nextCursor, more = {}) => ({ sessionId: 's', items, nextCursor, ended: false, captureState: 'LISTENING', ...more });

// A host that answers /rpc with `handler(method, args, calls)`; every request is logged. daemon.json points the CLI at it.
async function fakeHost(handler) {
  const dir = mkdtempSync(join(tmpdir(), 'pma-follow-test-')); const log = [];
  const server = createHttp(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk; const { method, args } = JSON.parse(body); let out;
    if (method === 'ping') out = { ok: true, result: { ok: true, testMode: true } };   // a test client talks only to a test host
    else { log.push({ method, args, at: Date.now() }); try { out = { ok: true, result: await handler(method, args, log) }; } catch (error) { out = { ok: false, error: String(error.message) }; } }
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(out));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  writeFileSync(join(dir, 'daemon.json'), JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, pid: process.pid, token: 't', version: 'test', startedAt: new Date().toISOString() }));
  const calls = name => log.filter(entry => entry.method === name).map(entry => entry.args);
  return { dir, log, calls, close: async () => { server.closeAllConnections?.(); await new Promise(r => server.close(r)); rmSync(dir, { recursive: true, force: true }); } };
}
// Runs the CLI; `marks` says how many release calls the host had seen when each piece of output arrived.
function cli(host, args, env = {}, killAfterMs = 30000) {
  // PMA_TEST_MODE: the CLI then uses a lock namespace inside host.dir and refuses any host that is not a test host (never the user's).
  const child = spawn(process.execPath, [resolve('dist/cli.js'), ...args], { env: { ...process.env, PMA_TEST_MODE: '1', PMA_DATA_DIR: host.dir, PMA_STOP_HOOK: 'off', ...env } });
  let out = ''; const marks = []; child.stdout.on('data', d => { out += d; marks.push({ text: String(d), releases: host.calls('release').length }); }); child.stderr.on('data', () => {});
  const done = new Promise(r => child.on('exit', code => r({ out, code, marks })));
  const timer = setTimeout(() => child.kill(), killAfterMs); return done.finally(() => clearTimeout(timer));
}
const withHost = async (handler, fn) => { const host = await fakeHost(handler); try { await fn(host); } finally { await host.close(); } };
const LEASE = /^[a-z0-9]{8,64}$/;

test('follow acknowledges only what it has printed: a batch waiting for its window keeps the ack before its first line while hidden rows move the scan on; then the ack catches up; release carries the last ack', async () => {
  let nextCalls = 0;
  await withHost((method, args) => {
    if (method === 'status') return status({ agentCursor: 9 });
    if (method === 'release') return { released: true };
    if (method === 'next') {
      if (args.limit === 1) return reply([], args.after);      // claiming the role
      nextCalls++;
      if (nextCalls === 1) return reply([10, 11, 12].map(id => row(id, 'xin chào ' + id)), 12);   // 13..15 were hidden rows, 16 is next
      if (nextCalls <= 5) return sleep(300).then(() => reply([], 15));
      if (nextCalls === 6) return reply([], 15);
      return reply([], 15, { ended: true });
    }
    throw new Error('unexpected ' + method);
  }, async host => {
    const { out, code } = await cli(host, ['follow', '--batch', '1', '--no-notes']);
    assert.equal(code ?? 0, 0); assert.match(out, /FOLLOWING chinh "Họp thử" từ #9 /); assert.match(out, /LÔ #10–#12 \(3 đoạn\):\n#10 .*xin chào 10\n#11 .*\n#12 .*\nKẾT THÚC: phiên đã đóng/);
    const nexts = host.calls('next'); const claim = nexts[0]; const main = nexts.slice(1);
    assert.deepEqual([claim.after, claim.ack, claim.limit, claim.waitMs, claim.as, claim.follower], [9, 9, 1, 0, 'chinh', true]); assert.match(claim.lease, LEASE);
    assert.ok(nexts.every(args => args.lease === claim.lease), 'one lease for the whole process');
    assert.deepEqual(main.map(args => args.after), [9, 12, 15, 15, 15, 15, 15]);
    // How many polls fit in the 1 s window depends on machine load; the invariant does not: while 10–12 wait unprinted the
    // ack stays at 9 although 13–15 were scanned, it never goes back, and once they are printed it is the scan (15).
    const acks = main.map(args => args.ack);
    assert.ok(acks.every(ack => ack === 9 || ack === 15) && acks.every((ack, i) => !i || ack >= acks[i - 1]), 'ack is 9 then 15, never in between or backwards: ' + acks);
    assert.deepEqual(acks.slice(0, 3), [9, 9, 9], 'unprinted rows 10–12 hold the ack back even though 13–15 were scanned');
    assert.equal(acks.at(-1), 15, 'once printed, the ack is the scan');
    assert.ok(main.every(args => args.ack < 15 || args.after === 15), 'the ack never runs ahead of the scan');
    assert.equal(main[1].ack, ackOf([row(10, 'x')], 12));
    const [release] = host.calls('release'); assert.deepEqual([release.as, release.lease, release.ack], ['chinh', claim.lease, 15]);
  });
});

test('a share role coming back to more than --max printable rows skips the oldest by number only and replays the last --max; chinh and an exact fit never skip', async () => {
  const handler = visible => (method, args) => {
    if (method === 'status') return status({ followers: { dich: { cursor: 0, at: null, unread: visible } } });
    if (method === 'release') return { released: true };
    if (method === 'read') return { items: Array.from({ length: visible }, (_, i) => row(i + 1, `câu số ${i + 1}.`)), nextCursor: visible, done: true };
    if (method === 'next') return args.limit === 1 ? reply([], args.after) : args.after < visible ? reply(Array.from({ length: visible - args.after }, (_, i) => row(args.after + i + 1, `câu số ${args.after + i + 1}.`)), visible) : reply([], args.after, { ended: true });
    throw new Error('unexpected ' + method);
  };
  await withHost(handler(60), async host => {
    const { out } = await cli(host, ['follow', '--as', 'dich', '--no-notes', '--max', '40']);
    assert.equal(out.match(/BỎ QUA/g).length, 1); assert.ok(out.includes('BỎ QUA #1–#20: quá cũ để chiếu lại (đọc ở phiên tổng hợp)\n'));
    assert.match(out, /LÔ #21–#60 \(40 đoạn\):/); assert.ok(!out.includes('câu số 1.') && !out.includes('câu số 20.') && out.includes('câu số 21.') && out.includes('câu số 60.'), 'skipped rows are named, never shown');
    assert.deepEqual(host.calls('read'), [{ sessionId: 's', after: 0, limit: 100, as: 'dich' }]);
    assert.deepEqual(host.calls('next').slice(1).map(args => [args.after, args.ack]), [[20, 20], [60, 60]], 'the skip is acknowledged with the next call');
    assert.equal(host.calls('release')[0].ack, 60);
  });
  await withHost(handler(40), async host => { const { out } = await cli(host, ['follow', '--as', 'dich', '--no-notes', '--max', '40']); assert.ok(!out.includes('BỎ QUA')); assert.match(out, /LÔ #1–#40 \(40 đoạn\):/); });
  await withHost(handler(60), async host => {
    const { out } = await cli(host, ['follow', '--no-notes', '--max', '40']);
    assert.ok(!out.includes('BỎ QUA')); assert.equal(host.calls('read').length, 0); assert.match(out, /LÔ #1–#60 \(60 đoạn\):/, 'chinh gets every row'); assert.ok(out.includes('câu số 1.'));
  });
});

test('a share role says once, without any text, that a replayed mixed file is not shown; chinh does not', async () => {
  const handler = (method, args) => method === 'status' ? status({ session: { id: 's', title: 'Phát lại', ended: null }, replay: { file: 'hop.mp4', speed: 4 } }) : method === 'read' ? { items: [], nextCursor: 0, done: true } : method === 'release' ? { released: true } : args.limit === 1 ? reply([], args.after) : reply([], args.after, { ended: true });
  const limit = 'GIỚI HẠN: đang phát lại file đã trộn — không tách được tiếng micro của người dùng khỏi loa, nên chữ không được chiếu ở vai này.';
  await withHost(handler, async host => { const { out } = await cli(host, ['follow', '--as', 'dich', '--no-notes']); assert.equal(out.split(limit).length - 1, 1); assert.doesNotMatch(out, /hop\.mp4/); });
  await withHost(handler, async host => { const { out } = await cli(host, ['follow', '--no-notes']); assert.ok(!out.includes('GIỚI HẠN')); });
});

test('FOLLOWER_BUSY: wait (saying so once), look at the cursor the holder left before each try, give up with DỪNG and exit code 1; the claim never reads from a stale cursor', async () => {
  let busy = 2; let statusCalls = 0;
  await withHost((method, args) => {
    if (method === 'status') return status({ followers: { dich: { cursor: 5 + statusCalls++, at: null, unread: 0 } } });
    if (method === 'read') return { items: [], nextCursor: args.after, done: true };
    if (method === 'release') return { released: true };
    if (args.limit === 1 && busy-- > 0) throw new Error('FOLLOWER_BUSY: vai dich đang có tiến trình theo dõi khác');
    return args.limit === 1 ? reply([], args.after) : reply([], args.after, { ended: true });
  }, async host => {
    const { out } = await cli(host, ['follow', '--as', 'dich', '--no-notes'], { PMA_FOLLOW_RETRY_MS: '40' });
    assert.equal(out.split('CHỜ: vai dich đang có tiến trình theo dõi khác').length - 1, 1);
    assert.deepEqual(host.calls('next').slice(0, 3).map(args => args.after), [5, 6, 7], 'each retry re-reads the cursor the other process left'); assert.match(out, /KẾT THÚC/);
  });
  await withHost((method, args) => method === 'status' ? status({ followers: { dich: { cursor: 3, at: null, unread: 0 } } }) : method === 'release' ? { released: false } : (() => { throw new Error('FOLLOWER_BUSY: vai dich đang có tiến trình theo dõi khác'); })(), async host => {
    const { out, code } = await cli(host, ['follow', '--as', 'dich', '--no-notes', '--after', '2'], { PMA_FOLLOW_RETRY_MS: '40', PMA_FOLLOW_BUSY_MAX_MS: '250' });
    assert.equal(code, 1); assert.equal(out.split('CHỜ:').length - 1, 1); assert.match(out, /DỪNG: vai dich vẫn đang có tiến trình theo dõi khác sau \d+ giây/);
    assert.ok(host.calls('next').length >= 3 && host.calls('next').every(args => args.after === 2), 'an explicit --after is kept');
    assert.equal(host.calls('release').length, 1, 'DỪNG also calls release (a no-op for a process that never held the role)');
  });
  // taken over while running: the batch it held belongs to the new owner now, and it starts again from the host's cursor
  let nextCalls = 0; let cursor = 0; let claimBusy = 0;
  await withHost((method, args) => {
    if (method === 'status') return status({ followers: { chinh: { cursor, at: null, unread: 0 } } });
    if (method === 'release') return { released: true };
    if (method === 'questions') return { due: [] };   // the synthesis role asks the host for due questions after each health check (ENG-46)
    if (args.limit === 1) { if (claimBusy-- > 0) throw new Error('FOLLOWER_BUSY: vai chinh đang có tiến trình theo dõi khác'); return reply([], args.after); }
    if (++nextCalls === 1) return reply([row(1, 'cũ một.')], 1);
    if (nextCalls === 2) { cursor = 1; claimBusy = 1; throw new Error('FOLLOWER_BUSY: vai chinh đang có tiến trình theo dõi khác'); }
    return reply([], args.after, { ended: true });
  }, async host => {
    const { out } = await cli(host, ['follow', '--no-notes', '--batch', '30'], { PMA_FOLLOW_RETRY_MS: '40' });
    assert.ok(!out.includes('cũ một.'), 'a batch of an overtaken process is not printed'); assert.match(out, /CHỜ: vai chinh/); assert.match(out, /KẾT THÚC/);
    assert.equal(host.calls('next').at(-1).after, 1);
  });
});

test('BẬT LẠI and KẾT THÚC come after the release, so the process Claude starts next finds the role free', async () => {
  let nextCalls = 0;
  await withHost((method, args) => {
    if (method === 'status') return status();
    if (method === 'release') return { released: true };
    if (args.limit === 1) return reply([], args.after);
    return ++nextCalls === 1 ? reply([row(1, 'một.'), row(2, 'hai.')], 2) : reply([], args.after, { ended: true });
  }, async host => {
    const { out, marks } = await cli(host, ['follow', '--no-notes', '--minutes', '0.00001']);
    assert.match(out, /LÔ #1–#2 \(2 đoạn\):\n#1 .*một\.\n#2 .*hai\.\nBẬT LẠI: theo dõi đã chạy 0 phút .*pma follow --no-notes\n$/);
    const again = marks.find(mark => mark.text.includes('BẬT LẠI')); assert.equal(again.releases, 1, 'released before the line was printed');
    const [release] = host.calls('release'); assert.deepEqual([release.as, release.ack], ['chinh', 2], 'the flushed batch is acknowledged');
  });
  await withHost((method, args) => method === 'status' ? status() : method === 'release' ? { released: false } : method === 'read' ? { items: [], nextCursor: 0, done: true } : args.limit === 1 ? reply([], args.after) : reply([], args.after, { ended: true }), async host => {
    const { out, marks } = await cli(host, ['follow', '--as', 'dich', '--no-notes']);
    assert.match(out, /KẾT THÚC: phiên đã đóng\n$/); assert.equal(marks.find(mark => mark.text.includes('KẾT THÚC')).releases, 1); assert.equal(host.calls('release')[0].as, 'dich');
  });
});

test('a folded group prints its mic label; a hallucination row stays content-free', async () => {
  const mic = (state, share) => `${MIC}; ${state}; ${share ? 'MIC_SHARE_OK; ' : ''}${LIVE}`;
  const rows = [...[1, 2, 3].map(id => row(id, 'cái', { boundary: mic('MIC_STATE_ON', true) })), ...[4, 5, 6].map(id => row(id, 'cái', { boundary: mic('MIC_STATE_OFF') })),
    row(7, 'Hãy subscribe cho kênh', { boundary: 'LIKELY_HALLUCINATION; ' + LIVE }), ...[8, 9, 10].map(id => row(id, 'cái'))];
  let n = 0;
  await withHost((method, args) => method === 'status' ? status() : method === 'release' ? { released: true } : args.limit === 1 ? reply([], args.after) : ++n === 1 ? reply(rows, 10) : reply([], 10, { ended: true }), async host => {
    const { out } = await cli(host, ['follow', '--no-notes']);
    assert.ok(out.includes('#1–#3 Tôi (mic bật) lặp ×3: cái\n')); assert.ok(out.includes('#4–#6 Tôi (mic tắt — nói riêng) lặp ×3: cái\n'));
    assert.ok(out.includes('#7 [bỏ: nghi câu ảo]\n') && !out.includes('subscribe')); assert.ok(out.includes('#8–#10 lặp ×3: cái\n'), 'the speaker group has no mic label');
  });
});

test('a hallucination row with a second reading that has words does not hide that reading; with nothing in it, it stays content-free (item 1b)', async () => {
  const reading = (language, more = {}) => ({ rv: 1, language, model: 'm-' + language, text: 'chữ-' + language, avgLogProb: -0.5, score: -0.5, viSyllableShare: null, viSyllables: 0, viTokens: 0, viSyllableVersion: 'v', loopPenalty: 0, status: 'ok', picked: false, ...more });
  const rows = [
    row(1, 'Hãy subscribe cho kênh', { boundary: 'LIKELY_HALLUCINATION; READINGS_UNDECIDED; ' + LIVE, alternatives: [reading('vi', { picked: true, text: 'Hãy subscribe cho kênh' }), reading('lo', { text: 'ລາຄາ P1 ແມ່ນ 120,000' })] }),
    row(2, 'Hãy subscribe cho kênh', { boundary: 'LIKELY_HALLUCINATION; READINGS_UNDECIDED; ' + LIVE, alternatives: [reading('vi', { picked: true }), reading('lo', { status: 'empty', text: '' })] }),
  ];
  let n = 0;
  await withHost((method, args) => method === 'status' ? status() : method === 'release' ? { released: true } : args.limit === 1 ? reply([], args.after) : ++n === 1 ? reply(rows, 2) : reply([], 2, { ended: true }), async host => {
    const { out } = await cli(host, ['follow', '--no-notes']);
    assert.ok(out.includes('#1 [bỏ: nghi câu ảo ở dòng chính; còn cách nghe khác]\n  ↳ vi (dòng chính) ['), out);
    assert.ok(out.includes('  ↳ lo (cách nghe song song) [') && out.includes(']: ລາຄາ P1 ແມ່ນ 120,000'), 'the other reading is printed with its text');
    assert.ok(out.includes('#2 [bỏ: nghi câu ảo]\n'), 'nothing to spare: content-free as before');
    assert.ok(!out.includes('subscribe'), 'the ghost phrase itself is never printed');
  });
});

test('pma read --as sends the role and prints only what it got; an all-hidden page still says where to go on; without --as it is the full read', async () => {
  const pages = { 0: { items: [row(3, 'công khai ba.')], nextCursor: 9, done: false }, 9: { items: [], nextCursor: 14, done: false }, 14: { items: [row(15, 'công khai mười lăm.')], nextCursor: 15, done: true } };
  await withHost((method, args) => { if (method === 'read') return pages[args.after]; throw new Error('unexpected ' + method); }, async host => {
    let r = await cli(host, ['read', '--as', 'dich']); assert.match(r.out, /^#3 .*công khai ba\.\nCÒN TIẾP: pma read --after 9 --as dich\n$/);
    r = await cli(host, ['read', '--as', 'dich', '--after', '9']); assert.equal(r.out, 'CÒN TIẾP: pma read --after 14 --as dich\n');
    r = await cli(host, ['read', '--as', 'dich', '--after', '14']); assert.match(r.out, /^#15 .*\nHẾT \(tới #15\)\n$/);
    r = await cli(host, ['read', '--as', 'dich', '--json', '--after', '9']); assert.deepEqual(JSON.parse(r.out), pages[9]);
    r = await cli(host, ['read']); assert.equal(r.out.endsWith('CÒN TIẾP: pma read --after 9\n'), true);
    const sent = host.calls('read'); assert.equal(sent.at(-1).as, undefined, 'no --as: the host is asked for the full read'); assert.ok(!('as' in sent.at(-1))); assert.equal(sent[0].as, 'dich');
  });
});

// ---- once against a real test host: schema of the new RPC fields and two real followers of one role ----
test('follow is pinned to its meeting: when A ends and B opens between two calls, the A process never reads, claims or acknowledges B; it prints what it holds, releases A and ends', async () => {
  let current = 's'; let nexts = 0;
  await withHost((method, args) => {
    if (method === 'status') return current === 's' ? status() : status({ session: { id: 'b', title: 'Họp B', ended: null }, agentCursor: 50 });
    if (args.sessionId !== current) throw new Error('SESSION_NOT_ACTIVE');
    if (method === 'release') return { released: true };
    if (method === 'read') return { items: [], nextCursor: args.after, done: true };
    if (method === 'next') {
      if (args.limit === 1) return reply([], args.after);
      if (++nexts === 1) { current = 'b'; return reply([row(1, 'cuối cuộc họp A')], 1); }   // A ends and B opens right after this reply
      return reply([row(51, 'đã là cuộc họp B')], 51);
    }
    throw new Error('unexpected ' + method);
  }, async host => {
    const { out, code } = await cli(host, ['follow', '--as', 'dich', '--no-notes', '--batch', '30']);
    assert.equal(code ?? 0, 0); assert.match(out, /LÔ #1–#1 \(1 đoạn\):\n#1 .*cuối cuộc họp A\nKẾT THÚC: phiên đã đóng/); assert.doesNotMatch(out, /cuộc họp B/);
    const scoped = host.log.filter(entry => entry.method !== 'status');
    assert.ok(scoped.length >= 3 && scoped.every(entry => entry.args.sessionId === 's'), 'every next/read/release names meeting A: ' + JSON.stringify(scoped.map(e => [e.method, e.args.sessionId])));
  });
  // --session that is not the open meeting: refused before anything is claimed
  await withHost(method => { if (method === 'status') return status(); throw new Error('unexpected ' + method); }, async host => {
    const { out, code } = await cli(host, ['follow', '--as', 'dich', '--session', 'other']);
    assert.equal(code, 1); assert.match(out, /SESSION_NOT_ACTIVE/); assert.equal(host.log.filter(entry => entry.method !== 'status').length, 0);
  });
});

test('a real host: lease, ack, release and read --as through /rpc; a second follow --as dich waits and gives up; release frees the role at once', async () => {
  // A world of its own (temp root, data dir, lock dir, free port, no inherited PMA_*); process.env is set from it only, before the import.
  const world = await isolatedEnv('follow-real');
  const env = { ...world.env, PMA_FOLLOW_RETRY_MS: '100', PMA_FOLLOW_BUSY_MAX_MS: '700' };
  const restoreEnv = applyEnv(env);
  const { call } = await import('../dist/client.js');
  const run = (...args) => new Promise(res => { const child = spawn(process.execPath, [resolve('dist/cli.js'), ...args], { env }); let out = ''; child.stdout.on('data', d => { out += d; }); child.on('exit', code => res({ out, code })); });
  try {
    await recordingHost(world.env, () => call('prepare', { title: 'Phiên khoá', fixture: true })); const first = (await call('fixture', { text: 'Đoạn một.' })).id;
    // chinh follows for a moment and releases at the end of its time: the role is free again at once
    const brief = await run('follow', '--no-notes', '--minutes', '0.00001'); assert.match(brief.out, /LÔ #1–#1 \(1 đoạn\):\n#1 .*Đoạn một\.\nBẬT LẠI/);
    const freed = (await call('status')).followers.chinh; assert.equal(freed.at, null); assert.equal(freed.cursor, first);
    // dich: a follower holds it; the second waits, says so once, then DỪNG with exit code 1
    const holder = spawn(process.execPath, [resolve('dist/cli.js'), 'follow', '--as', 'dich', '--no-notes', '--batch', '1'], { env }); let held = ''; holder.stdout.on('data', d => { held += d; });
    const stopped = new Promise(res => holder.on('exit', res));
    for (let i = 0; i < 50 && !(await call('status')).followers.dich?.at; i++) await sleep(100);
    const second = await run('follow', '--as', 'dich', '--no-notes'); assert.equal(second.code, 1); assert.equal(second.out.split('CHỜ:').length - 1, 1); assert.match(second.out, /DỪNG: vai dich vẫn đang có tiến trình theo dõi khác/);
    await assert.rejects(call('next', { as: 'dich', lease: 'zzzzzzzz1', after: 0, waitMs: 0 }), /FOLLOWER_BUSY/);
    await assert.rejects(call('next', { lease: 'BAD' }), /INVALID_INPUT/); await assert.rejects(call('next', { ack: -1 }), /INVALID_INPUT/); await assert.rejects(call('read', { as: 'Dich Hoa' }), /INVALID_INPUT/);
    const unleased = await call('next', { as: 'dich', after: 0, waitMs: 0, follower: true }); assert.equal(unleased.items.length, 1, 'a call without lease still reads');
    // the holder keeps printing; the unleased call did not move its cursor
    const second2 = (await call('fixture', { text: 'Đoạn hai.' })).id; for (let i = 0; i < 40 && !held.includes('Đoạn hai.'); i++) await sleep(100);
    // the ack of what it printed reaches the host with its next poll, a moment after the line appears
    assert.match(held, /#2 .*Đoạn hai\./); for (let i = 0; i < 40 && (await call('status')).followers.dich.cursor !== second2; i++) await sleep(100);
    assert.equal((await call('status')).followers.dich.cursor, second2);
    assert.equal((await call('read', { as: 'dich' })).items.length, 2); assert.equal((await call('read', {})).items.length, 2);
    assert.deepEqual(await call('release', { as: 'dich', lease: 'zzzzzzzz1', ack: 0 }), { released: false }); assert.equal((await call('status')).followers.dich.cursor, second2);
    await call('finish'); await stopped; assert.match(held, /KẾT THÚC/);
    // the final release after the meeting ended still lands (same meeting, role, lease): the role is free, at the last line printed
    const { committed, context, ...dich } = (await call('status')).followers.dich; assert.ok(context && typeof context.state === 'string', 'status also carries the context readiness of the role (ENG-45)'); assert.deepEqual(dich, { cursor: second2, at: null, unread: 0 }); assert.ok(committed <= second2);
    // a new meeting: a follower of it works as usual
    await call('prepare', { title: 'Phiên sau', fixture: true }); const b1 = (await call('fixture', { text: 'Cuộc họp B.' })).id;
    const next = await run('follow', '--as', 'dich', '--no-notes', '--minutes', '0.00002'); assert.match(next.out, new RegExp(`#${b1} .*Cuộc họp B\\.`));
  } finally { await teardown(world); restoreEnv(); }   // stops the host only if it is proven this test's own, then removes the root
});

// 03/11 meeting: `pma recheck` failed with "fetch failed" while the host was still working on it (fetch stops waiting for headers after
// 300 s). The CLI now talks to the host over node:http, limited only by the call's own timeout.
test('a slow host answer still arrives: recheck waits for the host, and the host error text is what the CLI prints', async () => {
  const delay = Number(process.env.PMA_SLOW_RPC_MS || 1500);
  await withHost(async (method, args) => {
    if (method === 'recheck' && args.sourceId === 5) { await sleep(delay); return { id: 1, sourceId: 5, text: 'nghe lại xong', language: 'vi', alternatives: [], silent: false }; }
    if (method === 'recheck') throw new Error('SOURCE_OUTSIDE_SESSION: ' + args.sourceId);
    throw new Error('UNEXPECTED ' + method);
  }, async host => {
    const t0 = Date.now(); const done = await cli(host, ['recheck', '5'], {}, delay + 30000);
    assert.equal(done.code, 0); assert.match(done.out, /nghe lại xong/); assert.ok(Date.now() - t0 >= delay, 'it waited for the host');
    const bad = await cli(host, ['recheck', '9']); assert.notEqual(bad.code, 0); assert.match(bad.out, /SOURCE_OUTSIDE_SESSION: 9/);
  });
});

test('a listening worker that has gone quiet is reported as stalled, not hidden behind its last small lag', async () => {
  let calls = 0;
  await withHost((method, args) => {
    if (method === 'status') return status({ captureInfo: { lagSeconds: 1.2, asrStalledSeconds: 120 } });
    if (method === 'release') return { released: true };
    if (method === 'next') { if (args.limit === 1) return reply([], args.after); calls++; return calls === 1 ? reply([row(1, 'câu cuối trước khi đứng')], 1) : sleep(300).then(() => reply([], 1, { ended: calls > 6 })); }
    return null;
  }, async host => {
    const { out } = await cli(host, ['follow', '--batch', '1', '--no-notes']);
    assert.match(out, /BỘ NGHE ĐỨNG: 120 giây chưa ra kết quả nào/); assert.doesNotMatch(out, /CẢNH BÁO TRỄ/);
  });
});

test('a role comes back where its work is saved (committed), not where it had printed to', async () => {
  await withHost((method, args) => {
    if (method === 'status') return status({ followers: { dich: { cursor: 10, committed: 6, at: null, unread: 0 } } });
    if (method === 'release') return { released: true };
    if (method === 'read') return { items: [], nextCursor: args.after, done: true };
    if (method === 'next') return reply([], args.after, { ended: args.limit !== 1 });
    return null;
  }, async host => {
    const { out } = await cli(host, ['follow', '--as', 'dich', '--no-notes']);
    assert.match(out, /FOLLOWING dich .* từ #6 /); assert.equal(host.calls('next')[0].after, 6); assert.equal(host.calls('next')[0].ack, 6);
  });
});
