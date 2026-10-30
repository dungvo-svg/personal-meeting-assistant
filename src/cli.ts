// `pma`: how Claude (or a person) drives the meeting runtime. Replies are compact JSON, except
// `follow` and `read`, which print transcript lines for Claude to read.
import { readFileSync } from 'node:fs';
import { call } from './client.js';
import { foldRuns, isHallucination, wrapLine } from './text.js';

const USAGE = `pma — trợ lý họp chạy trên máy
  pma start [--title T] [--agenda TEXT | --agenda-file F] [--link ZOOM_HOẶC_MEET_URL] [--languages vi,lo] [--me "Tên tôi"] [--at HH:MM]
                                   --link: Zoom (zoom.us/j/...) hoặc Google Meet (meet.google.com/abc-defg-hij)
                                   --me: tên người dùng (nhớ cho lần sau); --at: giờ họp theo lịch, để báo cáo ghi độ phủ
  pma at HH:MM [--session ID]      sửa giờ họp theo lịch của phiên đang mở (độ phủ tính lại; phiên đã kết thúc thì chạy pma raw lại)
  pma sources                      nguồn loa đang có tiếng (suggested)
  pma select <index>               cấp quyền nguồn loa (sau khi người dùng đồng ý)
  pma select-mic <index>           đổi micro kênh "Tôi" (mặc định: micro mà ứng dụng họp đang dùng, hoặc micro mặc định của Windows)
  pma listen [--no-mic] [--save-audio [--keep-days 7]]
                                   bật nghe, chờ tới LISTENING. Micro "Tôi" luôn mở, mọi nền tảng họp (tiếng loa lọt vào micro bị bỏ)
                                   --save-audio: lưu thêm file WAV trên máy này (không gửi đi), tự xoá sau --keep-days ngày (1–90, mặc định 7)
  pma follow [--batch 15] [--max 40] [--after N] [--as TÊN] [--no-notes]   in text mới theo lô (mỗi đoạn một dòng), dùng với Monitor
                                   --as: tên người theo dõi (mặc định chinh; hai phiên cùng theo dõi thì mỗi phiên một tên, vd. dich), mỗi tên giữ con trỏ đọc riêng
                                   --no-notes: bỏ nhắc ghi chú cuốn chiếu (phiên dịch không ghi chú); cảnh báo trễ và dòng micro vẫn giữ
  pma translate --source ID --text "tiếng Việt" | --file t.json   lưu bản dịch Claude cho đoạn tiếng Lào ([{"sourceId","text"}])
  pma status | pause | stop        trạng thái / tạm dừng (giữ mô hình, pma listen lại có chữ ngay) / kết thúc (ghi RAW.md)
  pma audio [list | purge [--older-than N]]   xem / xoá âm thanh đã lưu: purge xoá file hết hạn, --older-than N xoá file cũ hơn N ngày (0 = tất cả)
  pma read [--after N] [--limit 100] [--session ID]
  pma note --text T --sources 1,2 [--kind observation]
  pma summary --file SUMMARY.md --sources 1,2,3 [--session ID]
  pma tasks --file tasks.json [--session ID]       [{"task","owner?","due?","sourceIds":[..]}]
  pma raw [--session ID] | history | context
  pma glossary [list | add <Tên đúng> --variants "nghe sai 1,nghe sai 2" [--force] | remove <Tên đúng>]
  pma replay <file> [--speed 1] [--title T] [--agenda TEXT] [--languages vi,lo]
  pma shutdown`;

function options(argv: string[]) {
  const positional: string[] = []; const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { const key = argv[i].slice(2); flags[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'; }
    else positional.push(argv[i]);
  }
  return { positional, flags };
}
const list = (value?: string) => value ? value.split(',').map(v => Number(v.trim())).filter(Number.isInteger) : [];
const out = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const clock = (iso: string) => new Date(iso).toLocaleTimeString('vi-VN', { hour12: false });
const FLAG_LABELS: Record<string, string> = { LAO_WRITTEN_IN_THAI_SCRIPT: 'chữ Thái', REPETITION: 'lặp', LANG_UNSURE: 'ngôn ngữ không chắc', LAO_LOW_CONFIDENCE: 'Lào kém' };
const NOTE_EVERY_MS = 10 * 60000; const LAG_WARN_SECONDS = 10;
const micWhy = (by?: string) => !by ? '' : by.startsWith('meeting_app:') ? `micro ${by.slice(12)} đang dùng` : ({ windows_default: 'micro mặc định của Windows', selected: 'micro đã chọn', NO_MICROPHONE_FOUND: 'không thấy micro nào' } as Record<string, string>)[by] ?? by;
const megabytes = (bytes: number) => Math.round(bytes / 1048576);
const GLOSSARY_HELP = `pma glossary                      xem bảng tên
pma glossary add <Tên đúng> --variants "nghe sai 1,nghe sai 2"   thêm cách ASR hay nghe sai một tên
pma glossary remove <Tên đúng>    xoá tên khỏi bảng
Bảng chỉ đổi cách hiển thị ("MISA (nghe: mì da)"), không sửa chữ gốc. Biến thể quá ngắn, là từ thông dụng
(vd. "Ta") hoặc đã thuộc tên khác sẽ bị từ chối; thêm --force nếu chắc chắn.`;

function line(item: any) {
  if (item.origin === 'system_gap') return `#${item.id} [KHOẢNG TRỐNG] ${item.text}`;
  // Câu ảo khi im lặng chỉ để lại số đoạn, không đưa chữ vào để Claude không đọc nhầm thành nội dung.
  if (isHallucination(item)) return `#${item.id} [bỏ: nghi câu ảo]`;
  const flags = Object.entries(FLAG_LABELS).filter(([code]) => item.boundary?.includes(code)).map(([, label]) => label);
  const who = item.boundary?.includes('CHANNEL_MIC') ? ' Tôi' : '';
  return `#${item.id} ${clock(item.createdAt)}${who} ${item.language || '?'}${flags.length ? '⚠' + flags.join(',') : ''}: ${item.shown ?? item.text}`;
}
// Ba đoạn ngắn giống nhau trở lên (vòng lặp ASR) in thành một dòng.
const lines = (items: any[]) => foldRuns(items).map(g => g.count > 1 ? `#${g.first.id}–#${g.last.id} lặp ×${g.count}: ${g.first.shown ?? g.first.text}` : line(g.first));

function agenda(flags: Record<string, string>) { return flags['agenda-file'] ? readFileSync(flags['agenda-file'], 'utf8') : flags.agenda; }
function languagesOf(flags: Record<string, string>) { return flags.languages ? flags.languages.split(',').map(v => v.trim()) : undefined; }

async function follow(flags: Record<string, string>) {
  // 15 s by default: the 60 s batches of 29–30/10 made Claude's answers lag the meeting by a minute or more.
  const batchMs = Number(flags.batch || 15) * 1000; const maxLines = Number(flags.max || 40);
  let status = await call('status');
  if (!status.session || status.session.ended) { out({ error: 'NO_ACTIVE_SESSION' }); process.exitCode = 1; return; }
  const name = flags.as ?? 'chinh';
  if (!/^[a-z0-9-]{1,24}$/.test(name)) { out({ error: 'INVALID_FOLLOWER_NAME', hint: '--as chỉ gồm a-z, 0-9, dấu gạch ngang, tối đa 24 ký tự' }); process.exitCode = 1; return; }
  // Resume where this follower stopped; a new one starts at the main cursor (what the main follower has read).
  let after = flags.after ? Number(flags.after) : status.followers?.[name]?.cursor ?? status.agentCursor;
  let batch: any[] = []; let batchStarted = 0; let state = status.captureState; let failures = 0;
  console.log(`FOLLOWING ${name} "${status.session.title}" từ #${after} · lô ${batchMs / 1000}s · trạng thái ${state}`);
  const flush = () => {
    if (!batch.length) return;
    console.log(`LÔ #${batch[0].id}–#${batch.at(-1).id} (${batch.length} đoạn):`);
    for (const text of lines(batch)) for (const part of wrapLine(text)) console.log(part);
    batch = [];
  };
  // Sau mỗi lô: báo khi chữ ra chậm hơn lời nói, và nhắc ghi chú cuốn chiếu mỗi 10 phút nghe.
  let lastReminder = 0; let lastCheck = 0; let micDevice: string | undefined; let micChanged: string | undefined; let micError: string | undefined;
  const checkHealth = async () => {
    lastCheck = Date.now();
    const s = await call('status').catch(() => null); if (!s || s.captureState !== 'LISTENING') return;
    const info = s.captureInfo ?? {};
    if (info.micDevice && info.micDevice !== micDevice) { micDevice = info.micDevice; console.log(`MICRO TÔI: đang thu ${info.micDevice} (${micWhy(info.micSelectedBy)})`); }
    if (info.micError && info.micError !== micError) { micError = info.micError; console.log(`MICRO TÔI: không mở được micro, chỉ nghe loa (${info.micError})`); }
    if (info.micDeviceChanged && info.micDeviceChanged.to !== micChanged) { micChanged = info.micDeviceChanged.to; console.log(`MICRO TÔI ĐỔI: ứng dụng họp (${info.micDeviceChanged.app}) đang dùng "${info.micDeviceChanged.to}", máy vẫn thu "${info.micDeviceChanged.from ?? micDevice}". Muốn theo micro mới: pma pause rồi pma listen.`); }
    if (info.audioSaveError) console.log(`LƯU ÂM THANH LỖI: ${info.audioSaveError}`);
    const lag = s.captureInfo?.lagSeconds;
    if (typeof lag === 'number' && lag > LAG_WARN_SECONDS) console.log(`CẢNH BÁO TRỄ: chữ đang ra chậm ${Math.round(lag)} giây so với lời nói. Dừng việc nặng đang chạy trên máy.`);
    const since = Math.max(Date.parse(s.lastNoteAt ?? '') || 0, Date.parse(s.captureInfo?.listeningSince ?? '') || 0);
    if (flags['no-notes'] !== 'true' && since && Date.now() - since > NOTE_EVERY_MS && Date.now() - lastReminder > NOTE_EVERY_MS) { lastReminder = Date.now(); console.log(`NHẮC GHI CHÚ: đã hơn 10 phút chưa có ghi chú cuốn chiếu. Ghi tóm tắt khúc vừa rồi: pma note --text "..." --sources <id,...>`); }
  };
  for (;;) {
    let reply: any;
    // With a batch pending, wait no longer than what is left of its window.
    const waitMs = batch.length ? Math.max(200, batchMs - (Date.now() - batchStarted)) : 20000;
    try { reply = await call('next', { after, waitMs: Math.min(20000, waitMs), limit: 100, follower: true, as: name }, 40000); failures = 0; }
    catch (error) { if (++failures >= 5) { flush(); console.log(`DỪNG: không gọi được runtime (${error})`); process.exitCode = 1; return; } await new Promise(r => setTimeout(r, 3000)); continue; }
    // A state change is reported before the text that arrived with it.
    if (reply.captureState !== state) {
      flush(); state = reply.captureState;
      const s = await call('status').catch(() => null);
      console.log(`TRẠNG THÁI ${state}${s?.lastError ? ': ' + s.lastError : ''}${state === 'OFF' && s?.replay ? ' (phát lại đã hết)' : ''}`);
    }
    if (reply.items.length) { if (!batch.length) batchStarted = Date.now(); batch.push(...reply.items); after = reply.nextCursor; }
    if (reply.ended) { flush(); console.log('KẾT THÚC: phiên đã đóng'); return; }
    if (batch.length && (batch.length >= maxLines || Date.now() - batchStarted >= batchMs)) { flush(); await checkHealth(); }
    else if (Date.now() - lastCheck > 30000) await checkHealth();
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = options(rest);
  const session = flags.session ? { sessionId: flags.session } : {};
  switch (command) {
    case 'start': {
      const status = await call('prepare', { title: flags.title, agenda: agenda(flags), languages: languagesOf(flags), me: flags.me, at: flags.at });
      const opened = flags.link ? await call('open', { url: flags.link }) : undefined;
      const load = status.expectedLoadSeconds ? `, lần trước mất khoảng ${Math.round(status.expectedLoadSeconds)} giây` : '';
      return out({ ...status, opened, next: `Mô hình đang nạp sẵn (WARMING${load}). pma sources → hỏi người dùng → pma select <index> → pma listen (micro "Tôi" luôn mở) → Monitor "pma follow"` + (status.me ? '' : '. Chưa biết tên người dùng: thêm --me "Tên" ở lần start sau.') });
    }
    case 'at': return out(await call('schedule', { ...session, at: positional[0] ?? flags.at }));
    case 'sources': { const r = await call('sources', { levels: flags.levels !== 'false' }); return out({ suggested: r.suggested, devices: r.devices.map((d: any) => ({ index: d.index, name: d.name, kind: d.kind === 'microphone' ? 'mic' : 'speaker', default: d.isDefaultOutput || undefined, frames: d.level?.framesReceived, peak: d.level?.peak })) }); }
    case 'select': return out(await call('select', { ...session, deviceIndex: Number(positional[0]) }));
    // Micro "Tôi" is on by default (owner, 30/10/2026); select-mic only picks a different microphone.
    case 'select-mic': return out(await call('selectMic', { ...session, deviceIndex: Number(positional[0]), consent: true }));
    case 'listen': {
      const keepDays = flags['keep-days'] ? Number(flags['keep-days']) : undefined;
      if (keepDays !== undefined && !(Number.isInteger(keepDays) && keepDays >= 1 && keepDays <= 90)) throw new Error('--keep-days phải là số nguyên từ 1 đến 90');
      await call('listen', { ...session, mic: flags['no-mic'] !== 'true', saveAudio: flags['save-audio'] === 'true', ...(keepDays ? { keepDays } : {}) });
      // Model load took up to ~3 minutes on 30/10; wait for it instead of reporting a failure.
      const deadline = Date.now() + 300000; let status = await call('status');
      while (['WARMING', 'WARM_READY', 'LOADING_ASR', 'WAITING_FOR_SOURCE'].includes(status.captureState) && Date.now() < deadline) { await new Promise(r => setTimeout(r, 1500)); status = await call('status'); }
      return out({ captureState: status.captureState, lastError: status.lastError, device: status.captureInfo?.device, mic: status.captureInfo?.micDevice ?? undefined, micWhy: status.captureInfo?.micDevice ? micWhy(status.captureInfo.micSelectedBy) : status.captureInfo?.micError, modelLoadSeconds: status.captureInfo?.modelLoadSeconds, waitedForSourceSeconds: status.captureInfo?.waitedForSourceSeconds, rms: status.captureInfo?.rms, audio: status.audio ? { dir: status.audio.dir, expiresAt: status.audio.expiresAt, note: 'WAV ~0,7 GB/giờ cho cả loa và micro; tự xoá khi hết hạn hoặc pma audio purge' } : undefined, next: status.captureState === 'LISTENING' ? 'Monitor "pma follow"' : 'kiểm tra nguồn' });
    }
    case 'follow': return follow(flags);
    case 'translate': {
      const items = flags.file ? JSON.parse(readFileSync(flags.file, 'utf8')) : [{ sourceId: Number(flags.source), text: flags.text }];
      return out(await call('translate', { ...session, items }));
    }
    case 'status': return out(await call('status'));
    case 'pause': return out(await call('pause', session));
    case 'audio': {
      const action = positional[0] || 'list';
      if (action !== 'list' && action !== 'purge') throw new Error('pma audio [list | purge [--older-than N]]');
      const olderThanDays = flags['older-than'] !== undefined ? Number(flags['older-than']) : undefined;
      if (olderThanDays !== undefined && !(olderThanDays >= 0)) throw new Error('--older-than phải là số ngày (0 trở lên)');
      const r = await call('audio', { action, olderThanDays });
      if (action === 'list') return out(r.map((item: any) => ({ session: item.sessionId, title: item.title, dir: item.dir, files: item.files, mb: megabytes(item.bytes), expiresAt: item.expiresAt })));
      return out({ removed: r.removed.length, kept: r.kept, freedMb: megabytes(r.freedBytes) });
    }
    case 'stop': { const r = await call('finish', session); return out({ session: r.session, raw: r.raw, next: 'pma read → viết SUMMARY.md + tasks.json → pma summary / pma tasks' }); }
    case 'read': {
      const r = await call('read', { ...session, after: Number(flags.after || 0), limit: Number(flags.limit || 100) });
      if (flags.json) return out(r);
      for (const text of lines(r.items)) console.log(text);
      return console.log(r.done ? `HẾT (tới #${r.nextCursor})` : `CÒN TIẾP: pma read --after ${r.nextCursor}`);
    }
    case 'note': return out(await call('note', { ...session, key: flags.key || 'note-' + Date.now(), revision: Number(flags.revision || 1), kind: flags.kind || 'observation', text: flags.text, sourceIds: list(flags.sources) }));
    case 'summary': return out(await call('summary', { ...session, markdown: readFileSync(flags.file, 'utf8'), sourceIds: list(flags.sources) }));
    case 'tasks': return out(await call('tasks', { ...session, tasks: JSON.parse(readFileSync(flags.file, 'utf8')) }));
    case 'raw': return out(await call('raw', session));
    case 'history': return out(await call('history'));
    case 'glossary': {
      const action = positional[0] || 'list';
      if (flags.help || action === 'help') return console.log(GLOSSARY_HELP);
      return out(await call('glossary', { action, name: positional.slice(1).join(' ') || undefined, variants: flags.variants ? flags.variants.split(',') : [], force: flags.force === 'true' }));
    }
    case 'context': return out(await call('context'));
    case 'replay': {
      const status = await call('status');
      if (!status.session || status.session.ended) await call('prepare', { title: flags.title || 'Phát lại: ' + positional[0], agenda: agenda(flags), languages: languagesOf(flags) });
      await call('replay', { file: positional[0], speed: Number(flags.speed || 1) });
      return out({ replaying: positional[0], next: 'Monitor "pma follow"; khi báo phát lại đã hết: pma stop' });
    }
    case 'shutdown': return out(await call('shutdown'));
    default: console.log(USAGE); if (command && command !== 'help') process.exitCode = 1;
  }
}

main().catch(error => { out({ error: String(error?.message ?? error) }); process.exitCode = 1; });
