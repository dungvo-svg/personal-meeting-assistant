// `pma screen` for Google Meet (item 3 of docs/KE-HOACH-CAI-TIEN-2311.md). A real Meet meeting cannot be joined in a test, so the
// decisions live in pure PowerShell functions (tools/meeting_screen.ps1 -Library: no window, no screen capture, no files) and are
// tried here with synthetic UI Automation names and synthetic 32x18 grey signatures. The TS side (event lines, status, mode) is plain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { screenLine, screenStatus, watchMode } from '../dist/screen.js';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'meeting_screen.ps1');
const hasPowerShell = process.platform === 'win32' && spawnSync('powershell', ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).status === 0;
const ps = (body, data = null) => {
  // The data goes in as base64 UTF-8 JSON (Vietnamese and Lao fixtures survive the command line), the answer comes back as JSON.
  const payload = Buffer.from(JSON.stringify(data), 'utf8').toString('base64');
  const command = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $d = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json; . '${script.replace(/'/g, "''")}' -Library; ${body}`;
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return JSON.parse(r.stdout);
};
const T = { skip: !hasPowerShell && 'needs Windows PowerShell' };

// Synthetic signatures: 32x18 grey, 576 values.
const flat = (v) => Array(576).fill(v);
const slide = (seed) => Array.from({ length: 576 }, (_, i) => ((i * 37 + seed * 91) % 200) + 20); // busy: text-like
const other = slide(7).map(v => 255 - v);                                                          // a different slide

test('Meet windows are found by their title, the Meet home page is not one', T, () => {
  const titles = ['Meet - abc-defg-hij - Google Chrome', 'Meet \u2013 H\u1ecdp th\u1ea7u BV - Microsoft Edge', 'Meet - ', 'Google Meet', 'Meeting notes - Google Chrome', 'meet.google.com', 'Meet'];
  const got = ps('$d | ForEach-Object { Test-MeetTitle $_ } | ConvertTo-Json -Compress', titles);
  assert.deepEqual(got, [true, true, false, false, false, false, false]);
});

test('which window: forced mode, Zoom first in auto, the last kind kept, visible and biggest within a kind', T, () => {
  const z = { kind: 'zoom', hwnd: 1, minimized: false, area: 0 };
  const m1 = { kind: 'meet', hwnd: 2, minimized: true, area: 900 };
  const m2 = { kind: 'meet', hwnd: 3, minimized: false, area: 100 };
  const m3 = { kind: 'meet', hwnd: 4, minimized: false, area: 500 };
  const pick = (c, mode, prev) => ps('$r = Select-MeetingWindow $d.c $d.mode $d.prev; if ($r) { $r.hwnd } else { 0 }', { c, mode, prev: prev ?? '' });
  assert.equal(pick([z], 'auto'), 1);              // Zoom only: unchanged behaviour
  assert.equal(pick([z, m2], 'auto'), 1);          // both: Zoom first
  assert.equal(pick([z, m2], 'auto', 'meet'), 3);  // ... unless Meet was the one in use
  assert.equal(pick([z, m2], 'meet'), 3);          // override
  assert.equal(pick([z], 'meet'), 0);              // forced Meet, only Zoom open: nothing
  assert.equal(pick([m1, m2, m3], 'auto'), 4);     // visible first, then the biggest
  assert.equal(pick([], 'auto'), 0);
});

test('the presenter is read from Meet UI names: English, Vietnamese, Lao, own share, noise', T, () => {
  const names = [
    'Nguyen Van A is presenting', 'Linh Lin (You) is presenting', 'You are presenting to everyone', "You're presenting",
    "Quan's presentation", 'Presentation from Kham',
    'Tr\u1ea7n Th\u1ecb B \u0111ang tr\u00ecnh b\u00e0y', 'B\u1ea3n tr\u00ecnh b\u00e0y c\u1ee7a \u0110\u1ee9c', 'B\u1ea1n \u0111ang tr\u00ecnh b\u00e0y',
    '\u0e84\u0ea7\u0eb2\u0ea1 \u0e81\u0eb3\u0ea5\u0eb1\u0e87\u0e99\u0eb3\u0eaa\u0eb0\u0ec0\u0edc\u0eb5',
    'Stop presenting', 'Present now', 'Mute microphone', '', 'is presenting',
  ];
  const got = ps('$d | ForEach-Object { $r = ConvertFrom-PresenterText $_; if ($r) { [pscustomobject]@{ ok = $true; by = $r.by; self = $r.self } } else { [pscustomobject]@{ ok = $false } } } | ConvertTo-Json -Compress', names);
  const by = (i) => ({ by: got[i].by, self: got[i].self });
  assert.deepEqual(by(0), { by: 'Nguyen Van A', self: false });
  assert.deepEqual(by(1), { by: 'Linh Lin', self: false });       // "(You)" mark dropped, it is a name
  assert.deepEqual(by(2), { by: null, self: true });
  assert.deepEqual(by(3), { by: null, self: true });
  assert.deepEqual(by(4), { by: 'Quan', self: false });
  assert.deepEqual(by(5), { by: 'Kham', self: false });
  assert.deepEqual(by(6), { by: 'Tr\u1ea7n Th\u1ecb B', self: false });
  assert.deepEqual(by(7), { by: '\u0110\u1ee9c', self: false });
  assert.deepEqual(by(8), { by: null, self: true });
  assert.equal(got[9].by, '\u0e84\u0ea7\u0eb2\u0ea1');
  for (const i of [10, 11, 12, 13, 14]) assert.equal(got[i].ok, false, `name ${i} is not a presenter`);
});

test('observation: presenter, People panel (English and Vietnamese), speaker; nothing when no one presents', T, () => {
  const got = ps('Get-MeetObservation $d.names | ConvertTo-Json -Compress', { names: ['Meet', 'Chat', 'Kham is presenting', 'M\u1ecdi ng\u01b0\u1eddi', 'Hoa \u0111ang n\u00f3i'] });
  assert.deepEqual(got, { presenting: true, by: 'Kham', self: false, panel: true, speaker: 'Hoa' });
  const none = ps('Get-MeetObservation $d.names | ConvertTo-Json -Compress', { names: ['Turn on captions', 'Show everyone'] });
  assert.deepEqual(none, { presenting: false, by: null, self: false, panel: false, speaker: null });
});

test('presentation area: page below the browser bars, minus the control bar, minus the side panel; fallback when the page is unknown', T, () => {
  const area = (page, w, h, panel) => ps('Get-PresentationArea $d.page $d.w $d.h $d.panel | ConvertTo-Json -Compress', { page, w, h, panel });
  assert.deepEqual(area({ x: 0, y: 90, w: 1280, h: 800 }, 1280, 900, false), { x: 0, y: 90, w: 1280, h: 704 });
  assert.deepEqual(area({ x: 0, y: 90, w: 1280, h: 800 }, 1280, 900, true), { x: 0, y: 90, w: 888, h: 704 });
  assert.deepEqual(area(null, 1280, 900, false), { x: 0, y: 120, w: 1280, h: 684 });
  assert.deepEqual(area({ x: -5000, y: 0, w: 1280, h: 800 }, 1280, 900, false), { x: 0, y: 120, w: 1280, h: 684 }); // page rect outside the window: ignored
  assert.equal(ps('(Get-PresentationArea $null 500 300 $true) -eq $null | ConvertTo-Json -Compress', null), true);       // window too small: no area
});

test('signatures: flat is any single colour, a slide is not; the diff is the mean absolute grey change', T, () => {
  const r = ps('[pscustomobject]@{ black = (Test-SigFlat $d.black); grey = (Test-SigFlat $d.grey); white = (Test-SigFlat $d.white); slide = (Test-SigFlat $d.slide); same = (Get-SigDiff $d.slide $d.slide); apart = (Get-SigDiff $d.black $d.white); none = (Get-SigDiff $null $d.slide) } | ConvertTo-Json -Compress',
    { black: flat(0), grey: flat(32), white: flat(255), slide: slide(1) });
  assert.deepEqual(r, { black: true, grey: true, white: true, slide: false, same: 0, apart: 255, none: 255 });
});

// One Meet watcher run over a list of ticks; each tick is the observation (and the signature of the presentation area).
const run = (ticks, extra = '') => ps(
  `$s = New-MeetState; $out = @(); foreach ($t in $d.ticks) { $o = @{ presenting = [bool]$t.presenting; by = $t.by; self = [bool]$t.self; panel = [bool]$t.panel; speaker = $t.speaker; sig = $t.sig }; $r = Step-MeetState $s $o 12 3; $s = $r.state; $out += [pscustomobject]@{ types = (($r.events | ForEach-Object { $_.type }) -join ','); by = (($r.events | ForEach-Object { $_.by }) -join ','); reason = (($r.events | ForEach-Object { $_.reason }) -join ',') } }; ${extra} $out | ConvertTo-Json -Compress`,
  { ticks });
const types = (out) => (Array.isArray(out) ? out : [out]).map(o => o.types);

test('share_start, one frame per changed slide, share_stop, with the presenter name', T, () => {
  const p = (sig, by = 'Kham') => ({ presenting: true, by, sig });
  const out = run([{ presenting: false }, p(slide(1)), p(slide(1)), p(slide(1)), p(other), p(other), { presenting: false }, { presenting: false }]);
  assert.deepEqual(types(out), ['', 'share_start,frame', '', '', 'frame', '', 'share_stop', '']);
  assert.equal(out[1].by, 'Kham,Kham');
});

test('a covered or blank presentation area is MAN HINH AN once, no frame, then visible again and a frame', T, () => {
  const p = (sig, panel = false) => ({ presenting: true, by: 'Quan', panel, sig });
  const out = run([p(flat(30)), p(flat(30)), p(flat(30), true), p(flat(30), true), p(slide(2)), p(slide(2))]);
  // 3 flat ticks in a row -> hidden (the third tick, with the panel open, names the panel); never a frame from flat images
  assert.deepEqual(types(out), ['share_start', '', 'screen_hidden', '', 'screen_visible,frame', '']);
  assert.match(out[2].reason, /side panel/);
  const blank = run([p(flat(0)), p(flat(0)), p(flat(0))]);
  assert.deepEqual(types(blank), ['share_start', '', 'screen_hidden']);
  assert.match(blank[2].reason, /blank/);
});

test('one flat tick (a slide transition) is not MAN HINH AN', T, () => {
  const p = (sig) => ({ presenting: true, by: 'Quan', sig });
  assert.deepEqual(types(run([p(slide(1)), p(flat(0)), p(other)])), ['share_start,frame', '', 'frame']);
});

test('presenter handover: stop then start with the new name; an unread name does not erase the known one', T, () => {
  const out = run([{ presenting: true, by: 'An', sig: slide(1) }, { presenting: true, by: null, sig: slide(1) }, { presenting: true, by: 'Binh', sig: slide(1) }]);
  assert.deepEqual(types(out), ['share_start,frame', '', 'share_stop,share_start,frame']);
  assert.equal(out[2].by, 'An,Binh,Binh');
  const late = run([{ presenting: true, by: null, sig: slide(1) }, { presenting: true, by: 'An', sig: slide(1) }]);
  assert.deepEqual(types(late), ['share_start,frame', '']); // name read late fills in, no second start
});

test('own share: start/stop only, no frames and no hidden verdict (Meet shows a placeholder)', T, () => {
  const mine = (sig) => ({ presenting: true, self: true, sig });
  assert.deepEqual(types(run([mine(slide(1)), mine(flat(0)), mine(flat(0)), mine(flat(0)), { presenting: false }])), ['share_start', '', '', '', 'share_stop']);
});

test('active speaker from the page: one event per change, none is not an event', T, () => {
  const out = run([{ presenting: false, speaker: 'Hoa' }, { presenting: false, speaker: 'Hoa' }, { presenting: false, speaker: 'Lan' }, { presenting: false, speaker: null }]);
  assert.deepEqual(types(out), ['speaker', '', 'speaker', '']);
});

// ---- TypeScript side: lines for `follow`, status, mode ----
const at = '09:10:00';
test('event lines: MAN HINH AN names the cause, own share is said, the Meet window states', () => {
  assert.equal(screenLine({ at, utc: '', type: 'screen_hidden', by: 'Quan', panel: true }, 'D:/a'), `MÀN HÌNH ẨN ${at}: vùng trình bày của Quan đang trống hoặc bị che (khung bên phải như "Mọi người" đang mở — đóng khung đó); chưa chụp được ảnh — nhờ người chia sẻ/anh xem trực tiếp`);
  assert.match(screenLine({ at, utc: '', type: 'screen_hidden' }, 'D:/a'), /^MÀN HÌNH ẨN .*không thấy nội dung/);
  assert.match(screenLine({ at, utc: '', type: 'screen_visible', by: 'Quan' }, 'D:/a'), /đã hiện lại/);
  assert.match(screenLine({ at, utc: '', type: 'share_start', by: 'Quan', app: 'meet' }, 'D:/a'), /Quan bắt đầu chia sẻ/);
  assert.match(screenLine({ at, utc: '', type: 'share_start', self: true }, 'D:/a'), /Tôi \(chủ máy\) bắt đầu .*không chụp/);
  assert.equal(screenLine({ at, utc: '', type: 'meet_window', window: 'visible' }, 'D:/a'), null);
  assert.match(screenLine({ at, utc: '', type: 'meet_window', window: 'none' }, 'D:/a'), /Google Meet không thấy/);
  assert.match(screenLine({ at, utc: '', type: 'meet_window', window: 'minimized' }, 'D:/a'), /thu nhỏ/);
  assert.match(screenLine({ at, utc: '', type: 'frame', by: 'Quan', file: 'frames/091001.png' }, 'D:/a'), /ảnh màn hình chia sẻ của Quan: D:\/a\/screen\/frames\/091001\.png/);
});

test('status: app, sharing and hidden follow the events', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pma-screen-meet-'));
  try {
    mkdirSync(join(dir, 'screen'));
    const write = (events) => writeFileSync(join(dir, 'screen', 'screen.jsonl'), events.map(e => JSON.stringify({ at, utc: '2026-11-23T02:10:00.000Z', ...e })).join('\n'));
    write([{ type: 'start', mode: 'auto' }, { type: 'meet_window', window: 'visible' }, { type: 'share_start', by: 'Quan', app: 'meet' }, { type: 'screen_hidden', by: 'Quan' }]);
    let st = screenStatus(dir);
    assert.equal(st.app, 'meet'); assert.equal(st.hidden, true); assert.deepEqual({ by: st.sharing.by, self: st.sharing.self }, { by: 'Quan', self: false });
    write([{ type: 'start' }, { type: 'meet_window', window: 'visible' }, { type: 'share_start', by: 'Quan', app: 'meet' }, { type: 'screen_hidden' }, { type: 'screen_visible' }, { type: 'frame', file: 'frames/1.png' }]);
    assert.equal(screenStatus(dir).hidden, false);
    write([{ type: 'start' }, { type: 'zoom', window: 'visible' }, { type: 'share_start', by: 'Hoa' }]);
    st = screenStatus(dir);
    assert.equal(st.app, 'zoom'); assert.equal(st.hidden, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('watch mode: auto by default, zoom/meet forced, anything else refused', () => {
  assert.equal(watchMode(undefined), 'auto');
  assert.equal(watchMode('auto'), 'auto');
  assert.equal(watchMode('meet'), 'meet');
  assert.equal(watchMode('zoom'), 'zoom');
  assert.throws(() => watchMode('teams'), /--mode auto\|zoom\|meet/);
});

test('the script library loads without touching windows', T, () => {
  assert.equal(ps('(Get-Command Step-MeetState, Select-MeetingWindow, Test-MeetTitle).Count | ConvertTo-Json -Compress', null), 3);
});

// 0.13.8 (owner 25/11: catch who is speaking): page text new since the last tick goes to meet_text.jsonl. Synthetic UI Automation
// names: tile names and buttons stay the same tick to tick, captions and chat lines come and go.
test('Meet text log: only strings new since the last tick, each with the string before it (the caption speaker), blanks dropped, long ones cut, at most max', T, () => {
  // The caption speaker is also a tile name, so it is never new itself: it comes back as "before" of the caption words.
  const tick1 = ['Khounkham Souvannalath', 'Ms Tar', 'Turn off microphone', '', '  ', 'x'];
  const tick2 = ['Khounkham Souvannalath', 'Ms Tar', 'Turn off microphone', 'Captions', 'Ms Tar', 'em khảo sát mặt bằng tuần này', 'Huyền Nguyễn: Tar: khảo sát – hạn 28/11', 'em khảo sát mặt bằng tuần này'];
  const got = ps(`$a = Get-NewMeetTexts $d.t1 $null; $b = Get-NewMeetTexts $d.t2 $a.seen; $c = Get-NewMeetTexts $d.t2 $b.seen; $e = Get-NewMeetTexts @(('a' * 500), 'bb', 'cc', 'dd') $null 2 10; @{ a = @($a.new); b = @($b.new); c = @($c.new); e = @($e.new) } | ConvertTo-Json -Compress -Depth 4`, { t1: tick1, t2: tick2 });
  assert.deepEqual(got.a, [{ text: 'Khounkham Souvannalath', before: null }, { text: 'Ms Tar', before: 'Khounkham Souvannalath' }, { text: 'Turn off microphone', before: 'Ms Tar' }]);
  assert.deepEqual(got.b, [{ text: 'Captions', before: 'Turn off microphone' }, { text: 'em khảo sát mặt bằng tuần này', before: 'Ms Tar' }, { text: 'Huyền Nguyễn: Tar: khảo sát – hạn 28/11', before: 'em khảo sát mặt bằng tuần này' }]);
  assert.deepEqual(got.c ?? [], []);
  assert.deepEqual(got.e, [{ text: 'a'.repeat(10), before: null }, { text: 'bb', before: 'a'.repeat(10) }]);
});
