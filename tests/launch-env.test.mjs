import test from 'node:test';
import assert from 'node:assert/strict';
import { daemonEnvArgs, applyDaemonEnv } from '../dist/launch-env.js';

test('Windows launch round-trip preserves disabled microphone and explicit source choice', () => {
  const sent = { PMA_MIC: '0', PMA_AUTO_SOURCE: '0', PMA_DATA_DIR: 'C:\\Meeting data\\a=b', UNRELATED_SECRET: 'do not forward' };
  const args = daemonEnvArgs(sent);
  assert.ok(args.includes('PMA_MIC=0'));
  assert.ok(args.includes('PMA_AUTO_SOURCE=0'));
  assert.ok(!args.some(arg => arg.includes('UNRELATED_SECRET')));
  const received = {};
  applyDaemonEnv(args, received);
  assert.deepEqual(received, { PMA_DATA_DIR: sent.PMA_DATA_DIR, PMA_MIC: '0', PMA_AUTO_SOURCE: '0' });
});

test('host ignores unknown settings and incomplete arguments without changing defaults', () => {
  const received = { PMA_MIC: '0', PMA_AUTO_SOURCE: '0' };
  applyDaemonEnv(['--env', 'PATH=replaced', '--env', 'UNKNOWN=1', '--env'], received);
  assert.deepEqual(received, { PMA_MIC: '0', PMA_AUTO_SOURCE: '0' });
  const defaults = {};
  applyDaemonEnv(daemonEnvArgs({}), defaults);
  assert.deepEqual(defaults, {});
});
