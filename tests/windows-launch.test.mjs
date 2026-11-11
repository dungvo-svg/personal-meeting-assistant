// Real Windows launcher + production host, but only instrumented fake device backends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FAKE_WORKER, FAKE_RECORDER, until, readLog } from './fakes.mjs';

test('Windows WMI start receives no-mic before remembered source can open it', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const fixtureParent = resolve('.local', 'test-tmp'); mkdirSync(fixtureParent, { recursive: true });
  const root = mkdtempSync(join(fixtureParent, 'pma-launch-'));
  const data = join(root, 'data'); const tools = join(root, 'tools');
  mkdirSync(data); mkdirSync(tools);
  cpSync(resolve('dist'), join(root, 'dist'), { recursive: true });
  cpSync(resolve('web'), join(root, 'web'), { recursive: true });
  // Resolve the installed dependencies without copying or installing packages in the fixture.
  // The fixture root is beneath the worktree so dependency resolution is the same.
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(tools, 'package.json'), '{"type":"commonjs"}');
  writeFileSync(join(tools, 'audio_worker.py'), FAKE_WORKER);
  writeFileSync(join(tools, 'recorder.py'), FAKE_RECORDER);
  writeFileSync(join(tools, 'mix_audio.py'), '');
  writeFileSync(join(data, 'profile.json'), JSON.stringify({ speaker: { name: 'Loop' }, mic: { name: 'Mic' } }));
  const env = { ...process.env, PMA_PORT: process.env.PMA_PRIVACY_TEST_PORT || '18817', PMA_DATA_DIR: data,
    PMA_PYTHON: process.execPath, PMA_MIC: '0', PMA_AUTO_SOURCE: '0', PMA_EXIT_AFTER_FINISH: '1', PMA_IDLE_MINUTES: '0.1' };
  delete env.PMA_TEST_MODE; delete env.PMA_WARM;
  const exec = promisify(execFile);
  const cli = async (...args) => JSON.parse((await exec(process.execPath, [join(root, 'dist', 'cli.js'), ...args], { env, timeout: 30000 })).stdout);
  try {
    const started = await cli('start', '--title', 'Synthetic launcher privacy');
    const id = started.session.id; const audio = join(data, 'audio', id);
    assert.equal(readLog(audio, 'recorder-log.jsonl').length, 0, 'no remembered capture before explicit selection');
    await cli('select', '13'); // defaults ask for mic: the pre-start disable must still win
    await until(() => readLog(audio, 'recorder-log.jsonl').some(e => e.what === 'spawn'), 'fake recorder start');
    await cli('listen');
    for (const { argv } of readLog(audio, 'recorder-log.jsonl').filter(e => e.what === 'spawn')) {
      assert.ok(argv.includes('--speaker-device'));
      assert.ok(!argv.includes('--mic-auto') && !argv.includes('--mic-device'));
    }
    assert.equal(readLog(audio, 'recorder-log.jsonl').filter(e => e.what === 'mic-open').length, 0);
    assert.ok((await cli('status')).recorder.state === 'RECORDING');
  } finally {
    let hostPid;
    try { hostPid = JSON.parse(readFileSync(join(data, 'daemon.json'), 'utf8')).pid; } catch {}
    await cli('shutdown').catch(() => {});
    // Delete only our unique fixture root, after its host has left.
    if (hostPid) await until(() => { try { process.kill(hostPid, 0); return false; } catch { return true; } }, 'fixture host exit', 12000);
    assert.ok(root.startsWith(fixtureParent + '\\'));
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
