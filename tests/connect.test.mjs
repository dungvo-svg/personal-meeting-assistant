// `pma connect` (owner 25/11: machines differ, nothing hard-coded): a meeting folder gets the hop skill with THIS pma's
// full path and a Stop hook with this machine's node. Only temp folders are written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mergeStopHook, renderSkill } from '../dist/connect.js';

const ROOT = resolve('.').split('\\').join('/');
const run = (...args) => spawnSync(process.execPath, ['dist/cli.js', 'connect', ...args], { encoding: 'utf8' });
const folder = () => mkdtempSync(join(tmpdir(), 'pma-connect-'));
const settingsOf = dir => JSON.parse(readFileSync(join(dir, '.claude/settings.local.json'), 'utf8'));
const pmaHooks = settings => settings.hooks.Stop.flatMap(g => g.hooks).filter(h => h.command.includes('meeting_stop_hook'));

test('the repo skill carries no machine path; a copy gets this pma\'s full path', () => {
  const template = readFileSync('.claude/skills/hop/SKILL.md', 'utf8');
  assert.doesNotMatch(template, /[A-Za-z]:[\\/]/, 'no drive letter in the repo skill');
  const copy = renderSkill(template, 'E:/x/pma-home');
  assert.match(copy, /"E:\/x\/pma-home\/pma" guide/);
  assert.doesNotMatch(copy, /"\.\/pma"/);
});

test('connect writes skill and hook, and a second run changes nothing', () => {
  const dir = folder();
  try {
    const first = run('--project', dir);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /kỹ năng hop: đã chép/);
    assert.match(first.stdout, /Stop hook: đã thêm/);
    assert.ok(readFileSync(join(dir, '.claude/skills/hop/SKILL.md'), 'utf8').includes(`"${ROOT}/pma" guide`));
    const [hook] = pmaHooks(settingsOf(dir));
    assert.equal(hook.command, `"${process.execPath.split('\\').join('/')}" "${ROOT}/tools/meeting_stop_hook.mjs"`);
    const second = run('--project', dir);
    assert.match(second.stdout, /kỹ năng hop: không đổi/);
    assert.match(second.stdout, /Stop hook: không đổi/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a hook pointing at another pma is re-pointed once; other hooks and keys are kept', () => {
  const dir = folder();
  try {
    mkdirSync(join(dir, '.claude'));
    const other = { type: 'command', command: 'echo khac' };
    writeFileSync(join(dir, '.claude/settings.local.json'), JSON.stringify({ permissions: { allow: ['Read(x)'] }, hooks: { Stop: [
      { hooks: [other, { type: 'command', command: '"D:\\APP\\node.exe" "D:\\old\\pma\\tools\\meeting_stop_hook.mjs"', timeout: 15 }] },
      { hooks: [{ type: 'command', command: 'node "C:/again/tools/meeting_stop_hook.mjs"' }] },
    ] } }));
    const r = run('--project', dir);
    assert.match(r.stdout, /Stop hook: đã trỏ lại về bản pma này/);
    const settings = settingsOf(dir);
    assert.deepEqual(settings.permissions, { allow: ['Read(x)'] });
    assert.equal(pmaHooks(settings).length, 1, 'one pma Stop hook, not two');
    assert.ok(pmaHooks(settings)[0].command.includes(`${ROOT}/tools/meeting_stop_hook.mjs`));
    assert.deepEqual(settings.hooks.Stop[0].hooks[0], other);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('settings that are not JSON, or a missing folder, are refused without writing', () => {
  const dir = folder();
  try {
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude/settings.local.json'), '{ hỏng');
    const r = run('--project', dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /SETTINGS_NOT_JSON/);
    assert.equal(existsSync(join(dir, '.claude/skills')), false);
    const missing = run('--project', join(dir, 'khong-co'));
    assert.match(missing.stdout + missing.stderr, /PROJECT_NOT_FOUND/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('mergeStopHook adds to empty settings', () => {
  const { settings, action } = mergeStopHook(undefined, 'cmd meeting_stop_hook.mjs');
  assert.equal(action, 'added');
  assert.equal(settings.hooks.Stop[0].hooks[0].timeout, 15);
});
