// Screen watcher names on transcript lines (live 21/11 tender meeting): OCR junk cleaned, variants of one name joined, the right
// spelling from screen/names.json, and the sentence's own time (SEG_RANGE) used before the length estimate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanName, lineTimes, nameKey, nameResolver, sameName, speakersOf } from '../dist/screen.js';

const at = (s) => new Date(Date.UTC(2026, 10, 21, 2, 28, s)).toISOString();
const speaker = (s, name) => ({ type: 'speaker', utc: at(s), at: '', name });

test('OCR junk is dropped and the mic icon read as % is not part of a name', () => {
  assert.equal(cleanName('% Trang HN'), 'Trang HN');
  assert.equal(cleanName('  % Mr - NNC Hå Nöi '), 'Mr - NNC Hå Nöi');
  assert.equal(nameKey('Mr Đức - NNC Hà Nội'), 'mrducnnchanoi');
});

test('variants seen live are one person, short or different names are not', () => {
  assert.ok(sameName(nameKey('% Mr - NNC Hå Nöi'), nameKey('Mr Dirc - NNC Hå Nöi')));
  assert.ok(sameName(nameKey('Mr Dirc - NNC Hå Nöi'), nameKey('Mr Đức - NNC Hà Nội')));
  assert.ok(!sameName(nameKey('Linh Lin'), nameKey('Mr Son')));
  assert.ok(!sameName(nameKey('An'), nameKey('Anh')));
});

test('the most frequent spelling is shown, and names.json wins over it', () => {
  const events = [speaker(1, 'Mr Dirc - NNC Hå Nöi'), speaker(2, 'Mr Dirc - NNC Hå Nöi'), speaker(3, '% Mr - NNC Hå Nöi'), speaker(4, '% Trang HN'), speaker(5, 'Trang HN')];
  const shown = nameResolver(events, {});
  assert.equal(shown('% Mr - NNC Hå Nöi'), 'Mr Dirc - NNC Hå Nöi');
  assert.equal(shown('% Trang HN'), 'Trang HN');
  const fixed = nameResolver(events, { [nameKey('Mr Dirc - NNC Hå Nöi')]: 'Mr Đức - NNC Hà Nội' });
  assert.equal(fixed('% Mr - NNC Hå Nöi'), 'Mr Đức - NNC Hà Nội');
});

test('SEG_RANGE gives each sentence of a chunk its own time; without it the chunk is split by length', () => {
  const chunk = { wall: at(41), start: 100, end: 119 };
  const items = [
    { id: 1, ...chunk, text: 'aaaa', boundary: 'X; SEG_RANGE 0.00-6.00' },
    { id: 2, ...chunk, text: 'bb', boundary: 'X; SEG_RANGE 6.00-10.50' },
    { id: 3, wall: at(0), start: 0, end: 10, text: 'aaaaaaaa', boundary: '' },
    { id: 4, wall: at(0), start: 0, end: 10, text: 'aa', boundary: '' },
  ];
  const t = lineTimes(items);
  assert.equal(t.get(2).from, Date.parse(at(47)));
  assert.equal(t.get(2).estimated, false);
  assert.equal(t.get(4).from, Date.parse(at(8)));
  assert.equal(t.get(4).estimated, true);
});

test('speakers: the outline during the sentence, mic lines skipped, nothing after 30 s without an outline', () => {
  const events = [speaker(40, 'Linh Lin'), speaker(47, 'Mr Son')];
  const chunk = { wall: at(41), start: 100, end: 119 };
  const items = [
    { id: 1, ...chunk, text: 'x', boundary: 'SEG_RANGE 0.00-5.00' },
    { id: 2, ...chunk, text: 'y', boundary: 'SEG_RANGE 5.00-10.00' },
    { id: 5, ...chunk, text: 'v', boundary: 'SEG_RANGE 6.50-9.00' },
    { id: 3, ...chunk, text: 'z', boundary: 'CHANNEL_MIC; SEG_RANGE 10.00-12.00' },
    { id: 4, wall: new Date(Date.parse(at(47)) + 60000).toISOString(), start: 0, end: 3, text: 'w', boundary: '' },
  ];
  const names = speakersOf(items, events, item => item.boundary.includes('CHANNEL_MIC'));
  assert.equal(names.get(1), 'Linh Lin');
  assert.equal(names.get(2), 'Linh Lin→Mr Son');
  assert.equal(names.get(5), 'Mr Son');
  assert.equal(names.has(3), false);
  assert.equal(names.has(4), false);
});
