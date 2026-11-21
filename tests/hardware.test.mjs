// pma start refuses a meeting the machine cannot serve (owner 21/11), before any host, session or recording: the verdict is given
// through PMA_HARDWARE_JSON, the data dir points to an empty temp folder, so nothing real is reached.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = (verdict, args) => {
  const dir = mkdtempSync(join(tmpdir(), 'pma-hw-'));
  try {
    const r = spawnSync(process.execPath, ['dist/cli.js', 'start', '--title', 'x', ...args], { encoding: 'utf8', env: { ...process.env, PMA_HARDWARE_JSON: JSON.stringify(verdict), PMA_DATA_DIR: dir, PMA_TEST_MODE: '1' } });
    return { code: r.status, out: JSON.parse(r.stdout.trim().split('\n').at(-1)), files: readdirSync(dir) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

test('a machine that is not enough is refused before anything starts', () => {
  const r = run({ tier: 'khong-du', label: 'Không dùng cho họp trực tiếp', reasons: ['không có card NVIDIA có CUDA'], meeting: { ok: false, refused: ['vi'] } }, ['--languages', 'vi']);
  assert.equal(r.code, 1);
  assert.equal(r.out.error, 'HARDWARE_NOT_ENOUGH');
  assert.deepEqual(r.files, [], 'no host, no session file');
});

test('a Vietnamese-only machine refuses Lao and says to use --languages vi', () => {
  const r = run({ tier: 'tieng-viet', label: 'Chỉ họp tiếng Việt (và Thái)', reasons: ['VRAM 4096 MiB < 6000 MiB'], meeting: { ok: false, refused: ['lo'] } }, []);
  assert.equal(r.code, 1);
  assert.deepEqual(r.out.refusedLanguages, ['lo']);
  assert.match(r.out.hint, /--languages vi/);
});

test('full hardware without the Lao model points to setup_lao_gpu.sh', () => {
  const r = run({ tier: 'day-du', label: 'Đầy đủ', reasons: ['chưa cài mô hình Lào'], meeting: { ok: false, refused: ['lo'] } }, ['--languages', 'vi,lo']);
  assert.match(r.out.hint, /setup_lao_gpu\.sh/);
});
