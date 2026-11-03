// Controlled E2E on the candidate (03/11): PUBLIC audio -> ONE offline CPU ASR run -> a fixture source row of an isolated candidate host
// -> the native Claude session's own summary (written and saved by that session with the CLI) -> readback and comparison. Not a
// node:test file and not matched by tests/*.test.mjs: it is run once, on purpose, by whoever the gate clears, with cwd set to the
// BidOps project folder (cross-cwd proof). It reads and writes nothing in that folder.
//
//   node <candidate>/tests/e2e_public_vi_native.mjs --manifest <PMA-VI-CPU-PREP-*.json> --out <new empty receipt dir> [--wait-minutes 20]
//
// What it does, in order; any check that fails stops it, and the cleanup still runs:
//   1. rehash interpreter, ASR sources, model files, WAV and reference against the manifest; refuse on any mismatch;
//   2. one ASR run (the manifest's argv, process-only offline env, PMA_MIC=0, CUDA hidden), output RAW-asr.md in the test root;
//   3. a harness world (temp root/data/lock, free loopback port, PMA_TEST_MODE=1, PMA_WARM=0): read-only bootstrap (history), the host is
//      recorded and proven; fixture prepare; each ASR line as a fixture row with its language;
//   4. writes <root>/state.json (root, data/lock dirs, port, host pid, session, source ids, ASR provenance; no token) and
//      <root>/cli-env.json (the PMA_* the native session runs the CLI with), then waits for <root>/native-done.json;
//   5. the native session (not this script): status (same pid, same session), read, brief --as chinh (receipt), writes its summary to
//      <root>/native-summary.md and saves it with `cli.js summary --file … --sources … --receipt … --base 0`, then writes
//      native-done.json {cwd, hostPid, sessionId, sourceIds, receipt, contextVersion, summaryPath, revision, summarySha256};
//   6. readback: the raw rows unchanged, SUMMARY.md on disk carries native-summary.md verbatim, the host's report revision is 1;
//   7. finish, receipt.json in --out (sanitized), owned children closed, teardown with a confirmed cleanup.
// No device, no microphone, no loopback, no GPU, no download: file input only.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEnv, assertCleaned, guardedCall, isolatedEnv, recordingHost, teardown } from './harness.mjs';

const candidate = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = name => { const i = process.argv.indexOf('--' + name); return i < 0 ? undefined : process.argv[i + 1]; };
const manifestPath = arg('manifest'), outDir = arg('out'), waitMinutes = Number(arg('wait-minutes') ?? 20);
if (!manifestPath || !outDir) throw new Error('usage: --manifest <json> --out <new empty dir> [--wait-minutes 20]');
if (!Number.isFinite(waitMinutes) || waitMinutes < 1 || waitMinutes > 20) throw new Error('WAIT_MINUTES must be 1..20');
// The cross-cwd proof: this run and the native session's commands both start from the BidOps project folder, nothing is read there.
const EXPECTED_CWD = 'D:\\WORK\\Agent\\Agent-first\\NNC BidOps Agent';
const sameDir = (a, b) => resolve(String(a)).toLowerCase() === resolve(String(b)).toLowerCase();
if (!sameDir(process.cwd(), EXPECTED_CWD)) throw new Error('WRONG_CWD: run from ' + EXPECTED_CWD);
// Strictly inside `parent` (a sibling that only shares the prefix is outside).
const within = (parent, child) => { const rel = relative(resolve(parent), resolve(child)); return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel); };
if (existsSync(outDir) && readdirSync(outDir).length) throw new Error('OUT_NOT_EMPTY: ' + outDir);
mkdirSync(outDir, { recursive: true });
const LABEL = 'FIXTURE CÔNG KHAI FLEURS vi_vn test #0 (CC-BY-4.0) — phát lại chữ từ ASR file, không phải cuộc họp';
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const now = () => new Date().toISOString();
const receipt = { schema: 'pma-e2e-public-vi/1', candidate, cwd: process.cwd(), startedAt: now(), steps: [] };
const step = (name, data = {}) => { receipt.steps.push({ name, at: now(), ...data }); };
const save = () => writeFileSync(join(outDir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');

// 1. Hashes before anything runs.
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const pinned = [['interpreter', manifest.interpreter], ['fixture', manifest.fixture], ['reference', manifest.reference], ...Object.entries(manifest.source), ...Object.entries(manifest.model)];
const hashes = pinned.map(([name, f]) => ({ name, path: f.path, expected: f.sha256, actual: sha(f.path) }));
step('hashes-before', { hashes: hashes.map(h => ({ name: h.name, sha256: h.actual, ok: h.actual === h.expected })) });
const off = hashes.filter(h => h.actual !== h.expected);
if (off.length) { receipt.result = 'REFUSED_HASH_MISMATCH: ' + off.map(h => h.name).join(', '); save(); throw new Error(receipt.result); }

const world = await isolatedEnv('e2e-vi'); const restoreEnv = applyEnv(world.env);
let finished = false;
try {
  // 2. One ASR run, file input only.
  const rawAsr = join(world.root, 'RAW-asr.md');
  const argv = manifest.planned_argv.map(a => a === '<new-task-output>/RAW.md' ? rawAsr : a);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^PMA_/i.test(k))), ...manifest.process_only_env };
  const t0 = now();
  const asr = await new Promise(res => execFile(argv[0], argv.slice(1), { cwd: candidate, env, windowsHide: true, timeout: 10 * 60000, maxBuffer: 1 << 20 }, (error, stdout, stderr) => res({ code: error ? (error.code ?? 1) : 0, stdout, stderr })));
  step('asr', { argv: argv.map(a => a.replace(world.root, '<root>')), startedAt: t0, endedAt: now(), exit: asr.code, stderrTail: String(asr.stderr).slice(-400) });
  // The only new output of this run is kept in --out at once, whatever happens later (timeout, a denied write, a failed readback).
  writeFileSync(join(outDir, 'asr-stdout.log'), String(asr.stdout)); writeFileSync(join(outDir, 'asr-stderr.log'), String(asr.stderr));
  if (existsSync(rawAsr)) writeFileSync(join(outDir, 'RAW-asr.md'), readFileSync(rawAsr));
  save();
  if (asr.code !== 0 || !existsSync(rawAsr)) throw new Error('ASR_FAILED: exit ' + asr.code);
  const rawText = readFileSync(rawAsr, 'utf8');
  const lines = [...rawText.matchAll(/^\[\+\s*([\d.]+)s\] #(\d+) \((vi|lo|th)\) (.+)$/gm)].map(m => ({ at: Number(m[1]), n: Number(m[2]), language: m[3], text: m[4] }));
  step('asr-output', { sha256: sha(rawAsr), lines: lines.length, text: lines.map(l => l.text) });
  if (!lines.length) throw new Error('ASR_NO_LINES');

  // 3. An isolated candidate host: read-only bootstrap, then guarded fixture session and rows.
  const { call } = await import('../dist/client.js');
  await recordingHost(world.env, () => call('history')); const owned = guardedCall(world.env);
  const pong = await owned('ping'); step('host', { pid: pong.pid, version: pong.version, protocol: pong.protocol, capabilities: pong.capabilities, testMode: pong.testMode });
  const opened = await owned('prepare', { title: LABEL, fixture: true, languages: ['vi'] }); const sessionId = opened.session.id;
  const sourceIds = [];
  for (const l of lines) sourceIds.push((await owned('fixture', { text: l.text, language: l.language })).id);
  step('ingress', { sessionId, sourceIds, origin: 'synthetic_fixture', capture: 'NOT_APPLICABLE_FILE_INPUT' });

  // 4. Hand over to the native session.
  const cliEnv = Object.fromEntries(Object.entries(world.env).filter(([k]) => /^PMA_/.test(k)));
  writeFileSync(join(world.root, 'cli-env.json'), JSON.stringify(cliEnv, null, 2));
  writeFileSync(join(world.root, 'state.json'), JSON.stringify({ root: world.root, dataDir: world.env.PMA_DATA_DIR, lockDir: world.env.PMA_LOCK_DIR, port: world.env.PMA_PORT, hostPid: pong.pid, sessionId, sourceIds, cli: join(candidate, 'dist', 'cli.js'), asr: { rawAsrPath: rawAsr, sha256: sha(rawAsr), lines } }, null, 2));
  step('handover', { root: world.root, waitMinutes }); save();
  console.log('E2E_READY ' + join(world.root, 'state.json'));
  const done = join(world.root, 'native-done.json');
  for (const until = Date.now() + waitMinutes * 60000; !existsSync(done) && Date.now() < until;) await new Promise(r => setTimeout(r, 1000));
  if (!existsSync(done)) throw new Error('NATIVE_TIMEOUT: no native-done.json after ' + waitMinutes + ' min');

  // 6. Readback against what the native session wrote. Its hand-over is checked field by field BEFORE anything it names is read, and
  // the report is read only from the path the driver derives itself (this session's report folder, fixed file name), never elsewhere.
  const native = JSON.parse(readFileSync(done, 'utf8'));
  const status = await owned('status');
  const checks = {
    nativeCwd: typeof native.cwd === 'string' && sameDir(native.cwd, EXPECTED_CWD),
    nativePid: native.hostPid === pong.pid, nativeSession: native.sessionId === sessionId,
    nativeSources: Array.isArray(native.sourceIds) && native.sourceIds.length > 0 && native.sourceIds.every(id => sourceIds.includes(id)),
    nativeReceipt: typeof native.receipt === 'string' && /^rcpt-[a-f0-9]{16}$/.test(native.receipt),
    nativeContextVersion: typeof native.contextVersion === 'string' && native.contextVersion === status.context?.version,
    nativeRevision: native.revision === 1, hostRevision: status.revisions?.summary === 1,
  };
  const reports = join(world.env.PMA_DATA_DIR, 'reports');
  const folder = existsSync(reports) ? readdirSync(reports).filter(d => d.includes(sessionId.slice(0, 8))) : [];
  const reportPath = folder.length === 1 ? join(reports, folder[0], 'SUMMARY.md') : null;
  checks.reportFound = !!reportPath && within(world.root, reportPath) && existsSync(reportPath);
  checks.nativeNamedSamePath = !!reportPath && typeof native.summaryPath === 'string' && sameDir(native.summaryPath, reportPath);
  const mineFile = join(world.root, 'native-summary.md');
  const mine = existsSync(mineFile) ? readFileSync(mineFile, 'utf8').trim() : '';
  const mineSha = createHash('sha256').update(mine).digest('hex');
  checks.nativeSummaryHash = native.summarySha256 === mineSha && mine.length > 0;
  const onDisk = checks.reportFound ? readFileSync(reportPath, 'utf8') : '';
  checks.carriesNativeVerbatim = !!mine && onDisk.includes(mine);
  const rows = (await owned('read', { sessionId })).items;
  checks.rawUnchanged = rows.length === lines.length && rows.every((r, i) => r.text === lines[i].text && r.id === sourceIds[i]);
  step('readback', { checks, contextVersion: status.context?.version, receiptKind: 'ROLE_CONTEXT_RECEIPT_NOT_CONSUMER_IDENTITY', receipt: native.receipt, summarySha256: createHash('sha256').update(onDisk).digest('hex'), nativeSummarySha256: mineSha, reportPath: reportPath ? '<root>' + reportPath.slice(world.root.length) : null });
  receipt.result = Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL: ' + Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(', ');
  if (onDisk) writeFileSync(join(outDir, 'SUMMARY.md'), onDisk);
  if (mine) writeFileSync(join(outDir, 'native-summary.md'), mine + '\n');
  writeFileSync(join(outDir, 'native-done.json'), JSON.stringify(native, null, 2));
  await owned('finish', { sessionId }); finished = true; step('finish');
} catch (error) {
  receipt.result = receipt.result ?? 'FAIL: ' + String(error?.message ?? error).replace(/Bearer\s+\S+/g, 'Bearer ***').slice(0, 300);
} finally {
  try { const cleaned = assertCleaned(await teardown(world)); step('cleanup', { removed: cleaned.cleanup.removed, exited: cleaned.stop.exited }); }
  catch (error) { receipt.result = 'CLEANUP_NOT_CONFIRMED: ' + String(error?.message ?? error).slice(0, 300); }
  finally {
    restoreEnv(); receipt.endedAt = now(); receipt.finished = finished;
    receipt.hashesAfter = pinned.map(([name, f]) => { const actual = sha(f.path); return { name, sha256: actual, ok: actual === f.sha256 }; });
    // An input that changed during the run voids it, whatever else passed.
    if (receipt.hashesAfter.some(h => !h.ok) && receipt.result === 'PASS') receipt.result = 'FAIL: hashesAfter';
    save(); console.log('E2E_RESULT ' + receipt.result);
  }
}
process.exitCode = receipt.result === 'PASS' ? 0 : 1;
