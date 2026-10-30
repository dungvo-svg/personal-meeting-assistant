// `pma`: how Claude (or a person) drives the meeting runtime. Replies are compact JSON, except
// `follow` and `read`, which print transcript lines for Claude to read.
import { readFileSync } from 'node:fs';
import { call } from './client.js';
import { foldRuns, isHallucination, wrapLine } from './text.js';

const USAGE = `pma — trợ lý họp chạy trên máy
  pma start [--title T] [--agenda TEXT | --agenda-file F] [--link ZOOM_URL] [--languages vi,lo] [--me "Tên tôi"] [--at HH:MM]
                                   --me: tên người dùng (nhớ cho lần sau); --at: giờ họp theo lịch, để báo cáo ghi độ phủ
  pma sources                      nguồn loa đang có tiếng (suggested)
  pma select <index>               cấp quyền nguồn loa (sau khi người dùng đồng ý)
  pma select-mic <index>           đổi micro kênh "Tôi" (mặc định: micro Zoom đang dùng, hoặc micro mặc định của Windows)
  pma listen [--no-mic]            bật nghe, chờ tới LISTENING. Micro "Tôi" bật sẵn, chỉ lấy tiếng khi nút micro Zoom đang bật
  pma follow [--batch 60] [--max 40] [--after N]   in text mới theo lô (mỗi đoạn một dòng), dùng với Monitor
  pma status | pause | stop        trạng thái / tạm dừng / kết thúc (ghi RAW.md)
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
const MIC_GATE: Record<string, string> = { ON: 'đang lấy tiếng (micro Zoom đang bật)', MUTED: 'tạm bỏ tiếng (micro Zoom đang tắt)', NO_MEETING: 'tạm bỏ tiếng (chưa thấy cửa sổ họp Zoom)', UNKNOWN: 'tạm bỏ tiếng (không đọc được trạng thái micro Zoom)' };
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
  const batchMs = Number(flags.batch || 60) * 1000; const maxLines = Number(flags.max || 40);
  let status = await call('status');
  if (!status.session || status.session.ended) { out({ error: 'NO_ACTIVE_SESSION' }); process.exitCode = 1; return; }
  let after = flags.after ? Number(flags.after) : status.agentCursor;
  let batch: any[] = []; let batchStarted = 0; let state = status.captureState; let failures = 0;
  console.log(`FOLLOWING "${status.session.title}" từ #${after} · lô ${batchMs / 1000}s · trạng thái ${state}`);
  const flush = () => {
    if (!batch.length) return;
    console.log(`LÔ #${batch[0].id}–#${batch.at(-1).id} (${batch.length} đoạn):`);
    for (const text of lines(batch)) for (const part of wrapLine(text)) console.log(part);
    batch = [];
  };
  // Sau mỗi lô: báo khi chữ ra chậm hơn lời nói, và nhắc ghi chú cuốn chiếu mỗi 10 phút nghe.
  let lastReminder = 0; let lastCheck = 0; let micGate: string | undefined;
  const checkHealth = async () => {
    lastCheck = Date.now();
    const s = await call('status').catch(() => null); if (!s || s.captureState !== 'LISTENING') return;
    const gate = s.captureInfo?.micGate;
    if (gate && gate !== micGate) { micGate = gate; console.log(`MICRO TÔI: ${MIC_GATE[gate] ?? gate}${s.captureInfo?.micDevice ? ' · ' + s.captureInfo.micDevice : ''}`); }
    const lag = s.captureInfo?.lagSeconds;
    if (typeof lag === 'number' && lag > LAG_WARN_SECONDS) console.log(`CẢNH BÁO TRỄ: chữ đang ra chậm ${Math.round(lag)} giây so với lời nói. Dừng việc nặng đang chạy trên máy.`);
    const since = Math.max(Date.parse(s.lastNoteAt ?? '') || 0, Date.parse(s.captureInfo?.listeningSince ?? '') || 0);
    if (since && Date.now() - since > NOTE_EVERY_MS && Date.now() - lastReminder > NOTE_EVERY_MS) { lastReminder = Date.now(); console.log(`NHẮC GHI CHÚ: đã hơn 10 phút chưa có ghi chú cuốn chiếu. Ghi tóm tắt khúc vừa rồi: pma note --text "..." --sources <id,...>`); }
  };
  for (;;) {
    let reply: any;
    // With a batch pending, wait no longer than what is left of its window.
    const waitMs = batch.length ? Math.max(200, batchMs - (Date.now() - batchStarted)) : 20000;
    try { reply = await call('next', { after, waitMs: Math.min(20000, waitMs), limit: 100, follower: true }, 40000); failures = 0; }
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
      return out({ ...status, opened, next: `Mô hình đang nạp sẵn (WARMING${load}). pma sources → hỏi người dùng → pma select <index> → pma listen (micro "Tôi" bật sẵn, theo nút micro Zoom) → Monitor "pma follow"` + (status.me ? '' : '. Chưa biết tên người dùng: thêm --me "Tên" ở lần start sau.') });
    }
    case 'sources': { const r = await call('sources', { levels: flags.levels !== 'false' }); return out({ suggested: r.suggested, devices: r.devices.map((d: any) => ({ index: d.index, name: d.name, kind: d.kind === 'microphone' ? 'mic' : 'speaker', default: d.isDefaultOutput || undefined, frames: d.level?.framesReceived, peak: d.level?.peak })) }); }
    case 'select': return out(await call('select', { ...session, deviceIndex: Number(positional[0]) }));
    // Micro "Tôi" is on by default (owner, 30/10/2026); select-mic only picks a different microphone.
    case 'select-mic': return out(await call('selectMic', { ...session, deviceIndex: Number(positional[0]), consent: true }));
    case 'listen': {
      await call('listen', { ...session, mic: flags['no-mic'] !== 'true' });
      // Model load took up to ~3 minutes on 30/10; wait for it instead of reporting a failure.
      const deadline = Date.now() + 300000; let status = await call('status');
      while (['WARMING', 'WARM_READY', 'LOADING_ASR', 'WAITING_FOR_SOURCE'].includes(status.captureState) && Date.now() < deadline) { await new Promise(r => setTimeout(r, 1500)); status = await call('status'); }
      return out({ captureState: status.captureState, lastError: status.lastError, device: status.captureInfo?.device, mic: status.captureInfo?.micDevice ?? undefined, micGate: status.captureInfo?.micGate ? MIC_GATE[status.captureInfo.micGate] ?? status.captureInfo.micGate : undefined, modelLoadSeconds: status.captureInfo?.modelLoadSeconds, rms: status.captureInfo?.rms, next: status.captureState === 'LISTENING' ? 'Monitor "pma follow"' : 'kiểm tra nguồn' });
    }
    case 'follow': return follow(flags);
    case 'status': return out(await call('status'));
    case 'pause': return out(await call('pause', session));
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
