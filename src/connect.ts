// `pma connect`: hook a meeting folder up to THIS installed pma, wherever it was installed (owner 25/11: machines differ,
// nothing is hard-coded). It writes the hop skill with this pma's full path, and the Stop hook with this machine's node and
// this pma's hook script. Running it again changes nothing; a folder pointed at another pma is re-pointed here.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// The repo's own hop skill runs `"./pma"` (a session opened in the PMA folder); a copy elsewhere gets the full path.
export const SKILL_POINTER = '"./pma"';
const slash = (path: string) => path.split('\\').join('/');
const same = (a: string, b: string) => process.platform === 'win32' ? slash(resolve(a)).toLowerCase() === slash(resolve(b)).toLowerCase() : resolve(a) === resolve(b);

export function renderSkill(template: string, root: string): string {
  if (!template.includes(SKILL_POINTER)) throw new Error(`SKILL_TEMPLATE: kỹ năng hop của PMA không có ${SKILL_POINTER} để thay bằng đường dẫn máy này`);
  return template.replaceAll(SKILL_POINTER, `"${slash(root)}/pma"`);
}

export const hookCommand = (root: string, node: string) => `"${slash(node)}" "${slash(root)}/tools/meeting_stop_hook.mjs"`;

// Adds the Stop hook, or re-points an existing pma Stop hook (any path) to this one; other hooks and keys are kept.
export function mergeStopHook(settings: any, command: string): { settings: any; action: 'added' | 'updated' | 'unchanged' } {
  const next = structuredClone(settings && typeof settings === 'object' ? settings : {});
  next.hooks ??= {};
  next.hooks.Stop ??= [];
  let found = false, changed = false;
  for (const group of next.hooks.Stop) {
    const kept: any[] = [];
    for (const hook of group.hooks ?? []) {
      if (typeof hook?.command !== 'string' || !hook.command.includes('meeting_stop_hook')) { kept.push(hook); continue; }
      if (found) { changed = true; continue; } // a second pma Stop hook would run twice
      found = true;
      if (hook.command !== command) { hook.command = command; changed = true; }
      kept.push(hook);
    }
    if (group.hooks) group.hooks = kept;
  }
  next.hooks.Stop = next.hooks.Stop.filter((group: any) => !Array.isArray(group.hooks) || group.hooks.length);
  if (!found) next.hooks.Stop.push({ hooks: [{ type: 'command', command, timeout: 15 }] });
  return { settings: next, action: !found ? 'added' : changed ? 'updated' : 'unchanged' };
}

export function connect(project: string, root: string, node: string): string[] {
  const folder = resolve(project);
  if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new Error(`PROJECT_NOT_FOUND: không có thư mục ${slash(folder)}. Chưa ghi gì`);
  const settingsFile = resolve(folder, '.claude/settings.local.json');
  let settings: any = {};
  if (existsSync(settingsFile)) {
    try { settings = JSON.parse(readFileSync(settingsFile, 'utf8')); }
    catch { throw new Error(`SETTINGS_NOT_JSON: ${slash(settingsFile)} không đọc được dạng JSON; sửa tay rồi chạy lại. Chưa ghi gì`); }
  }
  const lines: string[] = [];
  if (same(folder, root)) lines.push(`kỹ năng hop: có sẵn (đây là thư mục PMA, dùng ${SKILL_POINTER})`);
  else {
    const skillFile = resolve(folder, '.claude/skills/hop/SKILL.md');
    const text = renderSkill(readFileSync(resolve(root, '.claude/skills/hop/SKILL.md'), 'utf8'), root);
    const before = existsSync(skillFile) ? readFileSync(skillFile, 'utf8') : null;
    if (before === text) lines.push(`kỹ năng hop: không đổi (${slash(skillFile)})`);
    else {
      mkdirSync(dirname(skillFile), { recursive: true });
      writeFileSync(skillFile, text);
      lines.push(`kỹ năng hop: ${before === null ? 'đã chép' : 'đã thay bản cũ'} → ${slash(skillFile)}`);
    }
  }
  const merged = mergeStopHook(settings, hookCommand(root, node));
  if (merged.action !== 'unchanged') {
    mkdirSync(dirname(settingsFile), { recursive: true });
    writeFileSync(settingsFile, JSON.stringify(merged.settings, null, 2) + '\n');
  }
  lines.push(`Stop hook: ${{ added: 'đã thêm', updated: 'đã trỏ lại về bản pma này', unchanged: 'không đổi' }[merged.action]} (${slash(settingsFile)})`);
  return lines;
}
