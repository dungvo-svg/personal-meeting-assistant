// Who said a line, and what that tells about its language (0.13.10). The Meet captions name the speaker (screen.ts: meetCaptions); the
// participants of the meeting say which languages each person speaks (start --participants, `languages`). Real meeting 25/11:
// 9 of 43 lines with two readings were shown as Lao, all wrong: no one spoke Lao that day; a Vietnamese-only participant's short reply
// was one of them. A line whose speaker is a person who speaks Vietnamese and not Lao is shown with its Vietnamese reading.
import { nameKey } from './screen.js';

export type ParticipantLike = { name: string; languages?: string[]; variants?: string[] };
const TITLES = new Set(['ms', 'mr', 'mrs', 'ceo', 'anh', 'chi', 'em', 'co', 'chu', 'ong', 'ba', 'sep', 'a', 'c']);
const words = (name: string) => name.split(/[\s/=,()]+/).map(nameKey).filter(word => word.length >= 3 && !TITLES.has(word));

// The participant a Meet tile name stands for: the participant's given name (the last word of a Vietnamese name, any word of a short
// one like "Ms Lan") is a word of the tile name ("Lan Phạm"), and only one participant fits. Unsure gives none (never a guess).
export function participantFor(tileName: string, participants: ParticipantLike[] | undefined): ParticipantLike | null {
  if (!participants?.length) return null;
  const tile = new Set(words(tileName)); if (!tile.size) return null;
  const fits = participants.filter(p => [p.name, ...(p.variants ?? [])].some(name => { const w = words(name); return w.length > 0 && tile.has(w.at(-1)!); }));
  return fits.length === 1 ? fits[0] : null;
}

// A line the ASR shows as Lao, said by someone who speaks Vietnamese and not Lao (by the participants list): its Vietnamese reading is
// the line. Returns null when that does not hold (no reading, no name, an unknown person, or a person who speaks Lao).
// `speakers` are the caption names of the line ("A→B" split); every one of them must be such a person.
export type Repick = { text: string; language: 'vi'; invented: boolean; who: string; basis: 'speaker' | 'caption' };
export function repickBySpeaker(item: { language?: string; alternatives?: any[] }, speakers: string[], participants: ParticipantLike[] | undefined): Repick | null {
  if (item.language !== 'lo' || !speakers.length) return null;
  const vi = (item.alternatives ?? []).find((a: any) => a?.rv !== undefined && a.language === 'vi');
  if (!vi || !String(vi.text ?? '').trim()) return null;
  for (const speaker of speakers) {
    const p = participantFor(speaker, participants);
    if (!p?.languages?.length || p.languages.includes('lo') || !p.languages.includes('vi')) return null;
  }
  return { text: String(vi.text), language: 'vi', invented: vi.status === 'invented', who: speakers.join('→'), basis: 'speaker' };
}

// A line the ASR shows as Lao whose Vietnamese reading is what the Meet captions of the same moment say (real meeting 26/11: the chair,
// who speaks both languages, said a short Vietnamese sentence; the ASR showed Lao, its Vietnamese reading was the caption's first words). Google
// heard Vietnamese words the Vietnamese reading also has: most of that reading's syllables (60%, at least 2) are in those captions.
// Lao speech under Vietnamese captions gives captions and a Vietnamese reading that are both noise and rarely share most syllables.
const syllables = (text: string) => text.normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
export function repickByCaption(item: { language?: string; alternatives?: any[] }, captions: { text: string; speaker: string }[] | undefined): Repick | null {
  if (item.language !== 'lo' || !captions?.length) return null;
  const vi = (item.alternatives ?? []).find((a: any) => a?.rv !== undefined && a.language === 'vi');
  if (!vi || vi.status === 'invented') return null;
  const heard = syllables(String(vi.text ?? '')); if (heard.length < 2) return null;
  const said = new Set(captions.flatMap(line => syllables(line.text)));
  const shared = heard.filter(word => said.has(word)).length;
  if (shared < 2 || shared / heard.length < 0.6) return null;
  const who: string[] = []; for (const line of captions) if (!who.includes(line.speaker)) who.push(line.speaker);
  return { text: String(vi.text), language: 'vi', invented: false, who: who.join('→'), basis: 'caption' };
}

// The people a line is by, for the language pick: the owner for their own microphone (not a speaker leak into it), else the caption names.
export function lineSpeakers(item: { boundary?: string }, captionNames: string | undefined, me: string | undefined): string[] {
  const boundary = item.boundary ?? '';
  if (boundary.includes('CHANNEL_MIC')) return me && !boundary.includes('MIC_BLEED') ? [me] : [];
  return captionNames ? captionNames.split('→') : [];
}
