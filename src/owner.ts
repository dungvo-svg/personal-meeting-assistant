// Who the owner is, for the pre-meeting brief: `.local/context/owner.json` (copy config/owner.example.json). The file is
// the owner's own, local only; nothing secret belongs in it, only how Claude should know and address them.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Owner = { name?: string; role?: string; company?: string; languages?: string[]; addressedAs?: string[] };

const text = (value: unknown, max = 80) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
const textList = (value: unknown, max = 8) => Array.isArray(value) ? value.map(v => text(v)).filter((v): v is string => !!v).slice(0, max) : undefined;

// A missing or broken file is not an error: the brief just has no "who I am" line from it.
export function loadOwner(root: string): Owner | null {
  let raw: any; try { raw = JSON.parse(readFileSync(join(root, '.local', 'context', 'owner.json'), 'utf8')); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const owner: Owner = { name: text(raw.name), role: text(raw.role), company: text(raw.company), languages: textList(raw.languages, 3), addressedAs: textList(raw.addressedAs) };
  return Object.values(owner).some(v => v !== undefined) ? owner : null;
}
