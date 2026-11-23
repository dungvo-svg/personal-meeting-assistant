// Who attends the meeting, as given by the owner before it starts (`pma participants --file p.json`, `pma start
// --participants p.json`). Part of the pre-meeting context: it tells Claude who is likely to speak and in which language,
// and which written forms ASR tends to make of each name. The variants go into the glossary (same risk checks).
import type { MeetingRuntime } from './runtime.js';
import { riskyVariants } from './text.js';

// One entry of the name table (item 8, 0.13.3). `kind` (default attendee): attendee = in the meeting; mentioned = spoken about, not in it; alias = a
// nickname or display name of someone (`name` is what is said or shown, `of` is the person: "Ta" of "Tar"; "Linh Lin" of "Quân"); system = a product or
// system word (Claude, OKR, MISA). `variants` are forms the recogniser tends to write. `weakVariants` are such forms that are also ordinary words
// ("dùng" for "Dũng"): shown corrected only where the sentence makes them a name (see weakNameRules in names.ts), never everywhere.
export type NameKind = 'attendee' | 'mentioned' | 'alias' | 'system';
export const NAME_KINDS: NameKind[] = ['attendee', 'mentioned', 'alias', 'system'];
export type Participant = { name: string; role?: string; languages?: string[]; variants?: string[]; kind?: NameKind; of?: string; weakVariants?: string[] };
export const PARTICIPANT_LANGUAGES = ['vi', 'lo', 'th'];
const MAX_PARTICIPANTS = 50;

const clip = (value: unknown, max = 80) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
const key = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();

// [{name, role?, languages?:["vi"|"lo"|"th"], variants?:[misheard forms], kind?, of?, weakVariants?}]. Same name twice is one entry.
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
    if (raw.kind !== undefined && !NAME_KINDS.includes(raw.kind)) throw new Error(`INVALID_PARTICIPANTS: ${name}: kind chỉ gồm ${NAME_KINDS.join(', ')}`);
    const kind: NameKind | undefined = raw.kind && raw.kind !== 'attendee' ? raw.kind : undefined;
    const of = clip(raw.of);
    if (kind === 'alias' && !of) throw new Error(`INVALID_PARTICIPANTS: ${name}: biệt danh (alias) cần "of": tên người mà biệt danh chỉ tới`);
    if (raw.weakVariants !== undefined && !Array.isArray(raw.weakVariants)) throw new Error(`INVALID_PARTICIPANTS: ${name}: weakVariants phải là danh sách`);
    const weak = [...new Set(((raw.weakVariants ?? []) as unknown[]).map(v => clip(v)).filter((v): v is string => !!v))];
    if (weak.length > 20) throw new Error(`INVALID_PARTICIPANTS: ${name}: tối đa 20 weakVariants`);
    const known = byName.get(key(name));
    if (known) { known.variants = [...new Set([...(known.variants ?? []), ...variants])]; known.role ??= clip(raw.role); known.languages ??= languages; if (of && known.kind === 'alias') known.of ??= of; if (weak.length) known.weakVariants = [...new Set([...(known.weakVariants ?? []), ...weak])]; return; }
    byName.set(key(name), { name, role: clip(raw.role), languages: languages?.length ? languages : undefined, variants: variants.length ? variants : undefined, ...(kind ? { kind } : {}), ...(of && kind === 'alias' ? { of } : {}), ...(weak.length ? { weakVariants: weak } : {}) });
  });
  return [...byName.values()];
}

// Stores the list in the open session's context (replacing any earlier list) and adds each person's variants to the
// glossary. A variant the glossary refuses (too short, an everyday word, another name's) is skipped and reported.
export function applyParticipants(runtime: MeetingRuntime, input: unknown) {
  runtime.requireSession(runtime.session?.id);
  const entries = parseParticipants(input);
  // Attendees stay "the people of the meeting" (context.participants: the brief's roster, the pack's roster, task owners); the rest of the table
  // (mentioned, alias, system) is context.names.
  const participants = entries.filter(p => !p.kind); const names = entries.filter(p => p.kind);
  const skippedVariants: { name: string; variant: string; why: string }[] = []; let variantsAdded = 0;
  for (const person of entries) {
    // A nickname is not a misheard form: "Ta" must never be rewritten to "Tar" in the text. It feeds the recogniser and the task owner only.
    if (person.kind === 'alias' || !person.variants?.length) continue;
    const risky = riskyVariants(person.name, person.variants, runtime.glossary);
    skippedVariants.push(...risky.map(r => ({ name: person.name, variant: r.variant, why: r.why })));
    const refused = new Set(risky.map(r => r.variant));
    const safe = person.variants.filter(v => !refused.has(v)); if (!safe.length) continue;
    try { runtime.glossaryAdd(person.name, safe); variantsAdded += safe.length; }
    catch (error: any) { skippedVariants.push(...safe.map(variant => ({ name: person.name, variant, why: String(error?.message ?? error) }))); }
  }
  const session = runtime.session;
  session.context = { ...session.context, participants, names };
  runtime.db.prepare('UPDATE sessions SET context=? WHERE id=?').run(JSON.stringify(session.context), session.id);
  // The new table goes to the recogniser from the next chunk on (names.ts writes <audio dir>/hotwords.json).
  const hotwords = runtime.writeHotwords(session.id); runtime.ping();
  return { participants: participants.length, names: names.length, glossaryVariantsAdded: variantsAdded, skippedVariants, hotwords: hotwords ? { vi: hotwords.vi, lo: hotwords.lo } : null };
}

// A task owner written the way ASR spelt a participant ("Nam Phủ") becomes the participant's name ("Namfon"). Only a
// listed variant (or the name itself, perhaps with a glossary "(nghe: …)" tail) triggers it; any other owner text is returned unchanged.
// A nickname listed as an alias ("Ta" of "Tar") also gives the person's name, for task owners only.
export function canonicalOwner(participants: Participant[] | undefined, owner?: string, names?: Participant[]) {
  if (!owner || (!participants?.length && !names?.length)) return owner;
  const spelt = key(owner.replace(/\s*\((?:nghe:[^)]*|sửa theo bảng tên)\)/giu, ''));
  return participants?.find(p => key(p.name) === spelt || p.variants?.some(v => key(v) === spelt))?.name
    ?? names?.find(p => p.kind === 'alias' && p.of && (key(p.name) === spelt || p.variants?.some(v => key(v) === spelt)))?.of ?? owner;
}
