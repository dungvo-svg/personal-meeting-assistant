// Who attends the meeting, as given by the owner before it starts (`pma participants --file p.json`, `pma start
// --participants p.json`). Part of the pre-meeting context: it tells Claude who is likely to speak and in which language,
// and which written forms ASR tends to make of each name. The variants go into the glossary (same risk checks).
import type { MeetingRuntime } from './runtime.js';
import { riskyVariants } from './text.js';

export type Participant = { name: string; role?: string; languages?: string[]; variants?: string[] };
export const PARTICIPANT_LANGUAGES = ['vi', 'lo', 'th'];
const MAX_PARTICIPANTS = 50;

const clip = (value: unknown, max = 80) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
const key = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();

// [{name, role?, languages?:["vi"|"lo"|"th"], variants?:[misheard forms]}]. Same name twice is one person.
export function parseParticipants(input: unknown): Participant[] {
  if (!Array.isArray(input)) throw new Error('INVALID_PARTICIPANTS: cần một danh sách [{"name","role?","languages?","variants?"}]');
  if (input.length > MAX_PARTICIPANTS) throw new Error(`INVALID_PARTICIPANTS: tối đa ${MAX_PARTICIPANTS} người`);
  const byName = new Map<string, Participant>();
  input.forEach((raw: any, index) => {
    const name = clip(raw?.name); if (!name) throw new Error(`INVALID_PARTICIPANTS: người thứ ${index + 1} thiếu name`);
    const languages = raw.languages === undefined ? undefined : Array.isArray(raw.languages) ? [...new Set(raw.languages.map((v: unknown) => String(v).trim().toLowerCase()))] as string[] : null;
    if (languages === null || languages?.some(code => !PARTICIPANT_LANGUAGES.includes(code))) throw new Error(`INVALID_PARTICIPANTS: ${name}: languages chỉ gồm vi, lo, th`);
    if (raw.variants !== undefined && !Array.isArray(raw.variants)) throw new Error(`INVALID_PARTICIPANTS: ${name}: variants phải là danh sách`);
    const variants = [...new Set(((raw.variants ?? []) as unknown[]).map(v => clip(v)).filter((v): v is string => !!v))];
    if (variants.length > 20) throw new Error(`INVALID_PARTICIPANTS: ${name}: tối đa 20 variants`);
    const known = byName.get(key(name));
    if (known) { known.variants = [...new Set([...(known.variants ?? []), ...variants])]; known.role ??= clip(raw.role); known.languages ??= languages; return; }
    byName.set(key(name), { name, role: clip(raw.role), languages: languages?.length ? languages : undefined, variants: variants.length ? variants : undefined });
  });
  return [...byName.values()];
}

// Stores the list in the open session's context (replacing any earlier list) and adds each person's variants to the
// glossary. A variant the glossary refuses (too short, an everyday word, another name's) is skipped and reported.
export function applyParticipants(runtime: MeetingRuntime, input: unknown) {
  runtime.requireSession(runtime.session?.id);
  const participants = parseParticipants(input);
  const skippedVariants: { name: string; variant: string; why: string }[] = []; let variantsAdded = 0;
  for (const person of participants) {
    if (!person.variants?.length) continue;
    const risky = riskyVariants(person.name, person.variants, runtime.glossary);
    skippedVariants.push(...risky.map(r => ({ name: person.name, variant: r.variant, why: r.why })));
    const refused = new Set(risky.map(r => r.variant));
    const safe = person.variants.filter(v => !refused.has(v)); if (!safe.length) continue;
    try { runtime.glossaryAdd(person.name, safe); variantsAdded += safe.length; }
    catch (error: any) { skippedVariants.push(...safe.map(variant => ({ name: person.name, variant, why: String(error?.message ?? error) }))); }
  }
  const session = runtime.session;
  session.context = { ...session.context, participants };
  runtime.db.prepare('UPDATE sessions SET context=? WHERE id=?').run(JSON.stringify(session.context), session.id); runtime.ping();
  return { participants: participants.length, glossaryVariantsAdded: variantsAdded, skippedVariants };
}

// A task owner written the way ASR spelt a participant ("Nam Phủ") becomes the participant's name ("Namfon"). Only a
// listed variant (or the name itself, perhaps with a glossary "(nghe: …)" tail) triggers it; any other owner text is returned unchanged.
export function canonicalOwner(participants: Participant[] | undefined, owner?: string) {
  if (!owner || !participants?.length) return owner;
  const spelt = key(owner.replace(/\s*\(nghe:[^)]*\)/giu, ''));
  return participants.find(p => key(p.name) === spelt || p.variants?.some(v => key(v) === spelt))?.name ?? owner;
}
