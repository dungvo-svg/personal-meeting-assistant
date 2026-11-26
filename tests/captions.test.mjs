// 0.13.10: Google Meet captions as a named second hearing (screen/meet_text.jsonl → caption lines), the speaker of each transcript line
// from them, and the language of a line from its speaker. A real meeting on 25/11 is the reason; every string here is made up (no
// meeting content in git): page chrome as Meet's Vietnamese UI writes it, people and sentences invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { captionLine, captionSpeakersOf, parseMeetCaptions } from '../dist/screen.js';
import { lineSpeakers, participantFor, repickByCaption, repickBySpeaker } from '../dist/speakers.js';
import { MeetingRuntime } from '../dist/runtime.js';
import { applyParticipants } from '../dist/participants.js';

const T0 = Date.parse('2030-01-01T08:00:00Z');
const at = s => new Date(T0 + s * 1000).toISOString();
const rec = (s, ...pairs) => ({ at: '', utc: at(s), texts: pairs.map(([text, before]) => ({ text, before })) });
// One meeting as the watcher logs it: the first tick is the whole page, then only strings new since the tick before.
const LOG = [
  rec(0, ['Meet - Họp thử', null], ['Thu nhỏ', 'Meet - Họp thử'], ['Đóng', 'Thu nhỏ'], ['An Trần', 'Đóng'], ['Ghim video của An Trần vào màn hình chính', 'An Trần'],
    ['Tắt tiếng micrô của Bình Lê', 'Ghim video của An Trần vào màn hình chính'], ['Tuỳ chọn khác cho Bình Lê', 'Tắt tiếng micrô của Bình Lê'],
    ['Bình Lê', 'Tuỳ chọn khác cho Bình Lê'], ['câu cũ đã có trên trang khi bắt đầu', 'Bình Lê']),
  rec(2, ['Mọi người', 'Bình Lê'], ['Mọi người cùng xem lại kho số hai nhé.', 'An Trần']),
  rec(4, ['Mọi người cùng xem lại kho số hai nhé, còn đủ hàng không', 'An Trần'], ['Nền và hiệu ứng', 'Bình Lê']),
  rec(6, ['Dạ còn đủ ạ.', 'Bình Lê'], ['Đang lắng nghe…', 'Bình Lê']),
  rec(8, ['tuần sau mình giao thêm', 'Dạ còn đủ ạ.']),
  rec(10, ['Cho em hỏi giá tuần này?', 'Bạn'], ['Nền và hiệu ứng', 'Bình Lê']),
  rec(12, ['Nền và hiệu ứng', 'Bình Lê']),
];

test('Meet captions: page chrome is dropped, tile names give the speaker, a rewritten line keeps its first time and takes its newest words', () => {
  const { lines, roster } = parseMeetCaptions(LOG);
  assert.deepEqual(roster.sort(), ['An Trần', 'Bình Lê']);
  assert.deepEqual(lines.map(l => [l.speaker, l.text, (l.first - T0) / 1000, (l.last - T0) / 1000, !!l.early, l.self]), [
    ['Bình Lê', 'câu cũ đã có trên trang khi bắt đầu', 0, 0, true, false],  // on the page when the log began: its time is unknown
    ['An Trần', 'Mọi người cùng xem lại kho số hai nhé, còn đủ hàng không', 2, 4, false, false],  // a caption may begin like a UI label
    ['Bình Lê', 'Dạ còn đủ ạ.', 6, 6, false, false],
    ['Bình Lê', 'tuần sau mình giao thêm', 8, 8, false, false],  // continues the line before it: same speaker
    ['Bạn', 'Cho em hỏi giá tuần này?', 10, 10, false, true],  // the owner's own captions
  ]);
  assert.equal(captionLine(lines[4], 'Dũng'), 'PHỤ ĐỀ MEET ' + new Date(T0 + 10000).toLocaleTimeString('vi-VN', { hour12: false }) + ' [Dũng]: Cho em hỏi giá tuần này?');
  assert.match(captionLine(lines[0]), /^PHỤ ĐỀ MEET trước /);
});

test('the speaker of a transcript line is who the captions showed during it; the opening page, microphone lines and silence give no name', () => {
  const { lines } = parseMeetCaptions(LOG);
  const row = (id, start, end, boundary = '') => ({ id, wall: at(start), start: 0, end: end - start, text: 'x', boundary: boundary + `; SEG_RANGE 0-${end - start}` });
  const items = [row(1, -3, -1), row(2, 0, 3), row(3, 4.5, 6.5), row(4, 9, 10, 'CHANNEL_MIC'), row(5, 30, 33), row(6, 9, 11)];
  const names = captionSpeakersOf(items, lines, item => item.boundary.includes('CHANNEL_MIC'), 'Dũng');
  assert.equal(names.get(1), undefined, 'before any caption, and the early line does not count');
  assert.equal(names.get(2), 'An Trần');
  assert.equal(names.get(3), 'An Trần→Bình Lê');
  assert.equal(names.get(4), undefined, 'the microphone is the owner, not a caption name');
  assert.equal(names.get(5), undefined, 'silence names nobody');
  assert.equal(names.get(6), 'Bình Lê', 'the owner\'s own captions ("Bạn") never name a speaker-channel line');
});

test('a tile name stands for one participant by the given name; a line shown as Lao by someone who does not speak Lao takes its Vietnamese reading', () => {
  const people = [{ name: 'Ms Lan', languages: ['vi'] }, { name: 'Somchai', languages: ['vi', 'lo'], variants: ['anh Chai'] }, { name: 'Nguyễn Văn Sơn', languages: ['vi'] }, { name: 'Dũng', languages: ['vi'] }];
  assert.equal(participantFor('Lan Phạm', people)?.name, 'Ms Lan');
  assert.equal(participantFor('Somchai KEOLA', people)?.name, 'Somchai');
  assert.equal(participantFor('Sơn Nguyễn', people)?.name, 'Nguyễn Văn Sơn');
  assert.equal(participantFor('Mai Đỗ', people), null);
  const reading = (language, more = {}) => ({ rv: 1, language, text: language === 'vi' ? 'dạ vâng em gửi bảng giá' : 'ຢ່າບ່ອງ', status: 'ok', picked: language === 'lo', ...more });
  const lao = { language: 'lo', alternatives: [reading('lo'), reading('vi')] };
  assert.deepEqual(repickBySpeaker(lao, ['Lan Phạm'], people), { text: 'dạ vâng em gửi bảng giá', language: 'vi', invented: false, who: 'Lan Phạm', basis: 'speaker' });
  assert.equal(repickBySpeaker(lao, ['Somchai KEOLA'], people), null, 'he speaks Lao: the pick stands');
  assert.equal(repickBySpeaker(lao, ['Lan Phạm', 'Somchai KEOLA'], people), null, 'every speaker of the line must be Vietnamese-only');
  assert.equal(repickBySpeaker(lao, ['Mai Đỗ'], people), null, 'unknown person: no guess');
  assert.equal(repickBySpeaker(lao, ['Lan Phạm'], undefined), null, 'no participants list: no guess');
  assert.equal(repickBySpeaker({ ...lao, language: 'vi' }, ['Lan Phạm'], people), null);
  assert.equal(repickBySpeaker({ language: 'lo', alternatives: [reading('lo'), reading('vi', { status: 'invented', text: 'Hãy subscribe' })] }, ['Lan Phạm'], people).invented, true);
  assert.deepEqual(lineSpeakers({ boundary: 'CHANNEL_MIC; MIC_ON' }, 'Lan Phạm', 'Dũng'), ['Dũng'], 'the owner\'s microphone is the owner');
  assert.deepEqual(lineSpeakers({ boundary: 'CHANNEL_MIC; MIC_BLEED #4' }, undefined, 'Dũng'), [], 'speaker sound leaking into the mic is not the owner');
  assert.deepEqual(lineSpeakers({ boundary: '' }, 'An→Bình', 'Dũng'), ['An', 'Bình']);
});

test('RAW carries the speaker of each line and the Meet captions in time order, and a line re-picked by its speaker says so', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-meeting-captions-'));
  const r = new MeetingRuntime(resolve('.'), directory, true); r.mixer = () => {};
  try {
    r.prepare('Họp thử phụ đề'); const id = r.session.id;
    applyParticipants(r, [{ name: 'Bình', languages: ['vi'] }, { name: 'An', languages: ['vi', 'lo'] }]);
    const screen = join(directory, 'audio', id, 'screen'); mkdirSync(screen, { recursive: true });
    writeFileSync(join(screen, 'meet_text.jsonl'), LOG.map(x => JSON.stringify(x)).join('\n') + '\n');
    const reading = (language, more = {}) => ({ rv: 1, language, model: 'm', text: language === 'vi' ? 'dạ còn đủ ạ' : 'ຢ່າບ່ອງ', avgLogProb: -0.5, score: -0.5, viSyllableShare: language === 'vi' ? 1 : 0, viSyllables: language === 'vi' ? 4 : 0, viTokens: 4, viSyllableVersion: 'vi-syl-rule-1', loopPenalty: 0, status: 'ok', picked: language === 'lo', ...more });
    r.ingest('mọi người cùng xem lại kho số hai', 'local_asr_unverified', 0, 3, 'SOURCE_LIVE_FOLLOW; SEG_RANGE 0-3', 'cap', 'vi', at(0), 1);
    r.ingest('ຢ່າບ່ອງ', 'local_asr_unverified', 0, 3, 'READINGS_UNDECIDED; SOURCE_LIVE_FOLLOW; SEG_RANGE 0-3', 'cap', 'lo', at(5.5), 1, [reading('lo'), reading('vi')]);
    r.ingest('cho em hỏi giá', 'local_asr_unverified', 0, 2, 'CHANNEL_MIC; SOURCE_LIVE_FOLLOW; SEG_RANGE 0-2', 'cap', 'vi', at(9.5), 1);
    const raw = readFileSync(r.writeRaw(id).path, 'utf8');
    assert.match(raw, /người nói: An Trần\) mọi người cùng xem lại kho số hai/);
    assert.match(raw, /\(nghe · vi · chọn tiếng Việt theo người nói: Bình Lê không nói tiếng Lào · người nói: Bình Lê\) dạ còn đủ ạ/);
    assert.match(raw, /\(phụ đề Meet · Tôi\) Cho em hỏi giá tuần này\?/);
    assert.match(raw, /\(phụ đề Meet · An Trần\) Mọi người cùng xem lại kho số hai nhé, còn đủ hàng không/);
    assert.match(raw, /\(phụ đề Meet · Bình Lê\) tuần sau mình giao thêm/);
    assert.match(raw, /\[trước [^\]]+\] \(phụ đề Meet · Bình Lê\) câu cũ đã có trên trang khi bắt đầu/);
    assert.ok(raw.indexOf('(phụ đề Meet · An Trần)') < raw.indexOf('vi · chọn tiếng Việt theo người nói:'), 'captions sit between the lines by time');
    assert.doesNotMatch(raw, /Nền và hiệu ứng|Đang lắng nghe|Ghim video/);
  } finally { await r.close(); rmSync(directory, { recursive: true }); }
});

// 0.13.11, real meeting 26/11: tile badges and a side-panel label cut short were read as captions of the tile's person.
test('Meet captions: tile badges and a label Meet cut short are page chrome, and so is what follows them', () => {
  const { lines } = parseMeetCaptions([
    rec(0, ['An Trần', null], ['Ghim video của An Trần vào màn hình chính', 'An Trần'], ['Người tổ chức cuộc họp', 'An Trần'], ['Bảng điều khiển bên', 'An Trần'],
      ['Bình Lê', 'Bảng điều khiển bên'], ['Tắt tiếng micrô của Bình Lê', 'Bình Lê'], ['Huy hiệu khách truy cập', 'Bình Lê'], ['Cho phép Bình Lê', 'Huy hiệu khách truy cập']),
    rec(2, ['Bảng điều khiển', 'An Trần'], ['Mình bắt đầu nhé.', 'An Trần']),
  ]);
  assert.deepEqual(lines.map(l => [l.speaker, l.text]), [['An Trần', 'Mình bắt đầu nhé.']]);  // any start of a label, 10 letters or more
});

// 0.13.11, real meeting 26/11: a person who speaks both languages said a Vietnamese sentence; the ASR showed Lao, its Vietnamese reading
// was the first words of the caption of the same moment.
test('language pick by the Meet captions of the same moment: the Vietnamese reading is what the caption says', () => {
  const lao = (vi, status = 'ok') => ({ language: 'lo', alternatives: [{ rv: 1, language: 'lo', text: 'ສະບາຍດີ', picked: true, status: 'ok' }, { rv: 1, language: 'vi', text: vi, status }] });
  const caption = [{ text: 'Để mình mời chị Mai vào phòng trước nhé.', speaker: 'An Trần' }];
  assert.deepEqual(repickByCaption(lao('Để mình mời'), caption), { text: 'Để mình mời', language: 'vi', invented: false, who: 'An Trần', basis: 'caption' });
  assert.equal(repickByCaption(lao('hoa hòm chút gọi bào với nhé'), caption), null);  // noise that shares a word or two
  assert.equal(repickByCaption(lao('Để mình mời', 'invented'), caption), null);
  assert.equal(repickByCaption(lao('mời'), caption), null);  // one syllable says nothing
  assert.equal(repickByCaption({ ...lao('Để mình mời'), language: 'vi' }, caption), null);
  assert.equal(repickByCaption(lao('Để mình mời'), undefined), null);
});
