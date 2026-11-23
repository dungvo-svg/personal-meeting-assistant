// `pma`: how Claude (or a person) drives the meeting runtime. Replies are compact JSON, except
// `follow` and `read`, which print transcript lines for Claude to read.
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pieces, RECHECK_PIECE_SECONDS } from './ranges.js';
import { randomBytes } from 'node:crypto';
import { attach, call, inspect, reach } from './client.js';
import { pagesOf } from './picture.js';
import { ackOf, foldRuns, isHallucination, micLabel, wrapLine } from './text.js';
import { loadNames, saveName, screenEvents, screenLine, screenStatus, speakersOf, startWatcher, stopWatcher } from './screen.js';

const USAGE = `pma — trợ lý họp chạy trên máy
  pma start [--title T] [--agenda TEXT | --agenda-file F] [--link ZOOM_HOẶC_MEET_URL] [--languages vi,lo,th] [--me "Tên tôi"] [--at HH:MM] [--purpose thong-bao|huong-dan|giao-viec|ban-quyet-dinh] [--participants p.json]
                                   --link: Zoom (zoom.us/j/...) hoặc Google Meet (meet.google.com/abc-defg-hij)
                                   --me: tên người dùng (nhớ cho lần sau); --at: giờ họp theo lịch, để báo cáo ghi độ phủ
                                   --purpose: họp để làm gì (nhận cả "thông báo", "hướng dẫn", "giao việc", "bàn quyết định"): dẫn đường cho bức tranh/SUMMARY/TASKS;
                                   họp thông báo/hướng dẫn thì việc, tên, số nêu khi làm mẫu là ví dụ, không vào TASKS
  pma purpose <giá trị> [--session ID]   đặt/đổi mục đích họp của phiên đang mở (context đổi bản: các vai đọc lại pma brief); pma brief in mục đích ở dòng đầu
  pma participants --file p.json   người dự họp (context trước họp): [{"name","role?","languages?":["vi"|"lo"|"th"],"variants?":["cách ASR nghe sai"]}]
                                   variants vào bảng tên (biến thể quá ngắn/thông dụng bị bỏ và báo lại); start --participants p.json làm cùng lúc
  pma picture update --file - --base N --receipt rcpt-… [--key K]   CẬP NHẬT bức tranh cộng dồn mỗi lô: chỉ gửi một JSON {"add":[{kind,text,sourceIds,certainty?,person?,deadline?}],
                                   "fix":[{targetId,expectedOld,replacement:{text,...},sourceIds,reason}],"dangBan":"…"}; kind: decision|task|number|question|fact; host giữ các mục và dựng bức tranh;
                                   mục cũ không bao giờ mất (sửa = "đã sửa: cũ → mới"); xong việc/đã trả lời = fix với replacement.status done|cancelled|resolved; một lần lưu là một giao dịch
  pma picture [--page N|all] [--json]   đọc bức tranh (bản lớn chia trang, báo rõ còn mấy trang); --json: các mục đang dùng kèm lịch sử sửa, để viết SUMMARY
  pma picture [--file f.md --sources 1,2 --base N --receipt rcpt-…]   (cũ) lưu CẢ văn bản bức tranh; bị từ chối khi bức tranh đã có các mục cộng dồn;
                                   lưu cần --receipt rcpt-… mà pma brief --as chinh in ra (đọc lại khi context đổi); --base N: bản đã đọc (lần đầu 0), BẮT BUỘC cho picture/summary/tasks; có bản mới hơn thì báo xung đột;
                                   --key K (picture, translate, participants, summary, tasks): gửi lại cùng khoá + cùng nội dung trả kết quả cũ, khác nội dung thì từ chối
                                   Nội dung nháp (picture, translate, participants, summary, tasks, job done) chỉ gửi cho host ĐANG chạy, không tự mở host
                                   Mọi lệnh lưu in biên nhận ("ĐÃ LƯU …: bản N, X ký tự, nguồn #…") hoặc lỗi tiếng Việt nói rõ cần sửa gì; không bao giờ im lặng.
                                   translate và picture còn lưu được tới 10 phút sau pma stop (bản dịch lô cuối của agent nền); sau đó báo NO_OPEN_SESSION
  pma transcribe <file…> [--out f.md] [--languages vi,lo,th]   file ghi âm (WhatsApp .opus/.ogg, .m4a, .mp3, .wav) thành chữ, chạy trên máy;
                                   không mở cuộc họp; câu bịa bị bỏ và đếm; mặc định ghi <file>-chu.md cạnh file đầu
  pma hardware [--json] [--languages vi,lo] bảng phần cứng + bậc của máy này (day-du / tieng-viet / khong-du), ngôn ngữ họp dùng được;
                                   pma start từ chối khi máy không đủ hoặc họp có tiếng Lào mà máy không chạy được mô hình Lào
  pma doctor [--json]             máy này có gì cho công cụ họp (Node, .venv, GPU, mô hình, nguồn âm, kỹ năng hop + Stop hook của thư mục đang đứng); chỉ đọc
  pma screen start|stop|status     canh cửa sổ Zoom (chỉ đọc, chạy trên máy): ai chia sẻ màn hình và lúc nào, ai Zoom đánh dấu đang nói
                                   (tên vào dòng chữ: [Tên]), ảnh màn hình chia sẻ khi nội dung đổi; lưu cạnh WAV trong screen/
  pma screen name "<tên máy đọc>" "<tên đúng>"   sửa tên OCR đọc sai/mất dấu cho cuộc họp này (các biến thể gần giống cũng theo)
  pma guide [dich]               quy trình họp của bản pma đang cài (kỹ năng hop chỉ trỏ tới đây); dich: phần cho agent dịch nền
  pma brief [--session ID]         context trước họp cho phiên Claude mới (≤ 2 KB): tôi là ai, họp gì, người dự, tên dễ nghe sai, một dòng tình trạng; chỉ đọc
  pma me --on | --off | --auto     micro "Tôi" đang bật/tắt khi máy không tự đọc được (ghi vào timeline, by:manual); --auto trả lại cho máy đọc
  pma at HH:MM [--session ID]      sửa giờ họp theo lịch của phiên đang mở (độ phủ tính lại; phiên đã kết thúc thì chạy pma raw lại)
  pma sources                      nguồn loa đang có tiếng (suggested)
  pma select <index> [--no-mic|--mic]   chọn nguồn loa (sau khi người dùng đồng ý) và BẮT ĐẦU GHI ÂM cả buổi (bộ ghi riêng, tới khi pma stop). Nhớ lựa chọn
                                   cho lần sau: pma start thấy đúng thiết bị đó thì ghi ngay, không cần select. Quyền chọn kéo dài cả phiên
  pma select-mic <index>           đổi micro kênh "Tôi" (mặc định: micro mà ứng dụng họp đang dùng, hoặc micro mặc định của Windows)
  pma listen                       bật nhận dạng chữ (ASR), chờ tới LISTENING; bộ nghe đuổi kịp từ giây đầu của bản ghi. Không giới hạn thời lượng.
                                   Bản ghi âm (WAV) là hộp đen của cả buổi: ghi từ lúc có nguồn loa tới pma stop, giữ trên máy này (không gửi đi) cho tới
                                   khi bạn tự xoá bằng pma audio purge. Micro "Tôi" luôn ghi (tiếng loa lọt vào micro bị bỏ); không muốn thì pma select --no-mic
  pma follow [--batch 15] [--max 40] [--after N] [--as TÊN] [--no-notes]   in text mới theo lô (mỗi đoạn một dòng), dùng với Monitor; tự thoát ở phút 29 và in BẬT LẠI; phiên --as khác chinh gửi lô ngay khi có dòng lo/th
                                   mỗi vai chỉ một tiến trình theo dõi (khoá 90 s): vai đang có người theo dõi thì CHỜ tới 100 s rồi DỪNG; vai khác chinh chỉ nhận chữ được phép chiếu (không có tiếng micro tắt/không rõ),
                                   bật lại mà còn hơn --max đoạn chưa chiếu thì in BỎ QUA #a–#b (không kèm chữ) và chỉ chiếu --max đoạn cuối; chinh không bao giờ bị bỏ
                                   --as: tên người theo dõi (mặc định chinh; hai phiên cùng theo dõi thì mỗi phiên một tên, vd. dich), mỗi tên giữ con trỏ đọc riêng
                                   --no-notes: bỏ nhắc ghi chú cuốn chiếu (phiên dịch không ghi chú); cảnh báo trễ và dòng micro vẫn giữ
  pma job start "<tên việc>" [--kind analysis|translation|other] | job done <id> --file kq.md [--sources 1,2] | job fail <id> "<lý do>" | job list [--status running]
                                   việc nền (phân tích dài, dịch): ghi lại để phiên trung tâm không phải chờ; kết thúc họp thì việc dở được dừng và liệt kê
  pma ask "<câu hỏi cho chủ>" [--sources 1,2] [--ttl 10] | answer <id> "<trả lời>" | questions
                                   câu hỏi chờ chủ: nhắc một lần sau --ttl phút, quá hạn thì đưa vào "Câu hỏi mở" (im lặng không phải đồng ý)
  pma brief [--as chinh|dich]       context trước họp; --as ghi nhận vai đó đã đọc phiên bản context này
  pma correct --raw "nghe sai" --to "đúng" [--source ID] [--confirmed] [--company] | doc --label "…" --pointer "đường dẫn/link"
  pma grant "<người>" [--scope "<chủ đề>"] --source "<lời chủ trong chat>"   CHỈ khi chủ giao thẩm quyền chốt
  pma propose "<đề xuất>" --sources 1,2 | decide <id> --by "<người>" --sources … | change <id> "<nội dung mới>" --by … --sources …
  pma withdraw <id> --by "<người>" --note "…" | act <idQĐ> "<việc>" | action done|fail|rollback <idViệc> "<kết quả/cách hoàn tác>" | decisions
  pma seat "<người>" [--role vai] [--role-desc "…"] [--scope "…"] | seat list [--expect "Quân,Oanh"]
                                   VAI GIẢ LẬP của một người trên máy này (không phải Claude thật của họ; Claude từ xa: chưa nối). Trả mã vai (seat-…) MỘT lần
  pma assign "<người>" "<việc>" [--sources 1,2] [--decision idQĐ] [--due HH:MM]   giao việc cho người đã có vai (QĐ phải đã chốt)
  pma role --seat MÃ               phần vai đó được thấy (việc, QĐ, câu hỏi của mình); đọc là ghi nhận đã đọc context hiện tại
  pma accept <idViệc> --seat MÃ | decline <idViệc> --seat MÃ "<lý do>" | reply <idViệc> --seat MÃ "<trả lời>" [--propose "<đề xuất>"] [--sources 1,2]
                                   trả lời KHÔNG chốt gì; đề xuất về phiên trung tâm
  pma converge | converge promote <idTrảLời> | converge handle reply|assignment|question <id> --by "<ai>" --note "…"
                                   việc phiên trung tâm phải xử lý; promote chỉ đưa đề xuất vào sổ QĐ (vẫn là đề xuất, chốt bằng pma decide)
  pma degraded <loại> "<chi tiết>" | degraded clear <loại>   ghi một tình trạng suy giảm (vd. save-denied); chỉ báo lần đầu
  pma say --text "…" [--session ID]   gõ tay một đoạn vào phiên đang mở (nguồn nhập tay, hiện "nhập tay" trong RAW; không phải lời nghe được)
  pma translate --source ID --text "tiếng Việt" | --file t.json   lưu bản dịch Claude cho đoạn tiếng Lào ([{"sourceId","text"}])
  pma status | pause | stop        trạng thái / tạm dừng CHỈ phần nhận dạng chữ (bộ ghi âm vẫn ghi; pma listen lại thì đuổi kịp) /
                                   kết thúc: dừng ghi, bộ nghe đọc nốt, ghép meeting-mix.wav, rồi mới ghi RAW.md (có thể mất vài phút)
  pma recheck <#id> | --from HH:MM:SS --to HH:MM:SS [--channel speaker|mic] [--beam 8] [--session ID]
                                   nghe lại một đoạn từ bản ghi âm (chậm hơn, kỹ hơn), lưu kết quả, đoạn đó hiện "(đã nghe lại: …)" trong RAW
  pma coverage [--json [--after N] [--limit 200]] [--session ID]   chỗ bản ghi có tiếng mà chưa có chữ, đoạn ASR lỗi, đoạn cờ không chắc: mỗi dòng kèm lệnh pma recheck
  pma audio [list | purge [--older-than N]]   xem âm thanh đã lưu (mỗi phiên: meeting-mix.wav dùng cho pma replay, hoặc "đang ghép") / xoá: âm thanh KHÔNG tự hết hạn,
                                   chỉ xoá khi bạn gõ lệnh này: --older-than N xoá phiên cũ hơn N ngày (0 = tất cả; phiên đang họp luôn được giữ)
  pma read [--after N] [--limit 100] [--session ID] [--as TÊN]   --as khác chinh: chỉ phần được phép chiếu cho vai đó (mặc định: đọc đủ như chủ)
  pma note --text T --sources 1,2 [--kind observation]
  pma summary --file SUMMARY.md --sources 1,2,3 [--session ID]
  pma tasks --file tasks.json [--session ID]       [{"task","owner?","due?","sourceIds":[..]}]
  pma raw [--session ID] | history | context
  pma glossary [list | add <Tên đúng> --variants "nghe sai 1,nghe sai 2" [--force] | remove <Tên đúng>]
  pma replay <file> [--speed 1] [--title T] [--agenda TEXT] [--languages vi,lo,th]
  pma shutdown`;

function options(argv: string[]) {
  const positional: string[] = []; const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { const key = argv[i].slice(2); flags[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'; }
    else positional.push(argv[i]);
  }
  return { positional, flags };
}
// --receipt (of `pma brief --as chinh`) and --key (idempotency) for the central drafts.
const draftFlags = (flags: Record<string, string>) => { const base = flags.base ?? flags['expect-revision']; return { ...(flags.receipt ? { receipt: flags.receipt } : {}), ...(flags.key ? { idempotencyKey: flags.key } : {}), ...(base !== undefined ? { expectedRevision: Number(base) } : {}) }; };
// --no-mic / --mic change the session's choice (kept until changed again); neither keeps it.
const micFlag = (flags: Record<string, string>) => flags['no-mic'] === 'true' ? { mic: false } : flags.mic === 'true' ? { mic: true } : {};
const list = (value?: string) => value ? value.split(',').map(v => Number(v.trim())).filter(Number.isInteger) : [];
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..').split('\\').join('/');
// guide/hop.md with the full path of this installed pma, so its commands run from any folder; `dich`: the background translator part.
function guide(part?: string) {
  const version = (() => { try { return JSON.parse(readFileSync(`${ROOT}/package.json`, 'utf8')).version; } catch { return '?'; } })();
  let text = readFileSync(`${ROOT}/guide/hop.md`, 'utf8').replace(/^<!--[\s\S]*?-->\r?\n/, '');
  if (part === 'dich') { const from = text.indexOf('## Brief agent dịch nền'); const to = text.indexOf('\n## ', from + 5); if (from < 0) throw new Error('GUIDE_PART_NOT_FOUND: dich'); text = text.slice(from, to < 0 ? undefined : to); }
  else if (part) throw new Error('pma guide [dich]');
  text = text.replaceAll('{{PMA}}', `"${ROOT}/pma"`).replaceAll('{{PMA_CMD}}', `"${ROOT}/pma.cmd"`).replaceAll('{{ROOT}}', ROOT);
  return `<!-- pma ${version} · ${ROOT} -->\n${text}`;
}
const venvPython = () => { const venv = `${ROOT}/.venv/${process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'}`; return existsSync(venv) ? venv : process.env.PMA_PYTHON || 'python'; };
// tools/hardware.py's verdict for a meeting in these languages. PMA_HARDWARE_JSON gives a verdict (tests); a test-mode client
// (PMA_TEST_MODE=1) skips the check; no Python or no answer is 'unknown', which `start` refuses.
function hardwareVerdict(languages: string[]): any | null {
  if (process.env.PMA_HARDWARE_JSON) return JSON.parse(process.env.PMA_HARDWARE_JSON);
  if (process.env.PMA_TEST_MODE === '1') return null;
  const r = spawnSync(venvPython(), ['-I', `${ROOT}/tools/hardware.py`, '--json', '--languages', languages.join(',')], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  try { return JSON.parse(r.stdout); } catch { return { tier: 'unknown', error: r.error?.message || (r.stderr ?? '').trim().slice(-300) || 'tools/hardware.py không trả lời' }; }
}
// `--file -` reads the text from stdin (0.12.1): the agent hands drafts (picture, translations, summary, tasks, participants) straight to
// the host through a pipe, so it writes no draft file of its own anywhere; the host stores them as before.
const input = (file?: string) => { if (!file) throw new Error('--file <đường dẫn> hoặc --file - (đọc từ stdin)'); return file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8'); };
const out = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');

// ---- Save commands never stay silent (0.13.0, item 5) ----
// 23/11: `pma picture --base 26` printed nothing and the picture stayed at revision 26; a missing --sources only said "Too small". Every
// save (picture, translate, participants, summary, tasks, job done) now ends in a receipt line (what was saved: revision, characters,
// sources) or in a Vietnamese refusal that says what to fix. Nothing here changes what the host stores.
const SAVE_ONLY_FLAGS = ['base', 'expect-revision', 'sources', 'receipt', 'key'];
// --sources 120,121 or #120,#121: every item must be a real #id. A flag with no value, or an item that is not a number, is an error here
// (the old list() dropped such items silently and the host then answered "Too small").
function sourcesOf(flags: Record<string, string>, what: string, required = true): number[] {
  const raw = flags.sources;
  const tokens = raw === undefined || raw === 'true' ? [] : raw.split(',').map(t => t.trim().replace(/^#/, '')).filter(Boolean);
  const bad = tokens.filter(t => !/^[1-9]\d*$/.test(t));
  if (bad.length) throw new Error(`SOURCES_INVALID: ${what}: --sources có giá trị không phải #id: ${bad.join(', ')}. Dùng số đoạn như pma follow / pma read in ra, ví dụ --sources 120,121`);
  if (!tokens.length && required) throw new Error(`SOURCES_REQUIRED: ${what} cần --sources <id,…>: ít nhất một #id có chữ thật (ví dụ --sources 120,121; #id lấy từ pma follow / pma read). Chưa lưu gì`);
  return tokens.map(Number);
}
// Text for a save: stdin that is empty (a heredoc that never arrived) must not look like a save of nothing.
function contentOf(file: string | undefined, what: string): string {
  const text = input(file);
  if (!text.trim()) throw new Error(`CONTENT_EMPTY: ${what}: nội dung đọc từ ${file === '-' ? 'stdin' : file} đang rỗng. Chưa lưu gì`);
  return text;
}
function jsonOf(file: string | undefined, what: string): any {
  try { return JSON.parse(contentOf(file, what)); }
  catch (error: any) { if (String(error?.message).startsWith('CONTENT_EMPTY')) throw error; throw new Error(`JSON_INVALID: ${what}: nội dung không phải JSON hợp lệ (${String(error?.message ?? error).slice(0, 120)}). Chưa lưu gì`); }
}
const ids = (list: number[]) => list.length ? '#' + [...new Set(list)].sort((a, b) => a - b).join(', #') : 'không có';
// The host's answer turned into the receipt. A reply that does not say it saved is an error, never a quiet success.
function saved(what: string, result: any, detail: { chars?: number; sourceIds?: number[]; label?: string }) {
  const chars = result?.chars ?? detail.chars; const sources = result?.sourceIds ?? detail.sourceIds ?? [];
  const confirmed = result?.saved === true || (typeof result?.saved === 'number' && result.saved > 0) || result?.participants !== undefined;
  if (result?.saved === false && result?.job) return out({ ...result, line: `${what}: việc #${result.job.id} đã có kết quả giống hệt, không ghi lại` });
  if (!confirmed) throw new Error(`SAVE_NOT_CONFIRMED: ${what}: host không xác nhận đã lưu (${JSON.stringify(result)?.slice(0, 160)}). Coi như CHƯA lưu; kiểm pma status rồi lưu lại`);
  const revision = result.revision !== undefined ? `bản ${result.revision}` : '';
  const body = [revision, chars !== undefined ? `${chars} ký tự` : '', sources.length ? 'nguồn ' + ids(sources) : ''].filter(Boolean).join(', ');
  const verb = result.duplicate ? `GIỐNG HỆT bản đã có, không tạo bản mới: ${what}` : `ĐÃ LƯU ${what}`;
  return out({ ...result, line: `${verb}${body ? ' (' + body + ')' : ''}${result.path ? ' → ' + result.path : ''}` });
}
const clock = (iso: string) => new Date(iso).toLocaleTimeString('vi-VN', { hour12: false });
const FLAG_LABELS: Record<string, string> = { LAO_MODEL_MISSING: 'thiếu mô hình Lào: chữ Thái phiên âm, nghĩa chưa tin', LAO_WRITTEN_IN_THAI_SCRIPT: 'chữ Thái', REPETITION: 'lặp', LANG_UNSURE: 'ngôn ngữ không chắc', LAO_LOW_CONFIDENCE: 'Lào kém', TIMESTAMP_INVALID: 'giờ không tin được' };
const MAIN = 'chinh';
const NOTE_EVERY_MS = 10 * 60000; const LAG_WARN_SECONDS = 10;
const micWhy = (by?: string) => !by ? '' : by.startsWith('meeting_app:') ? `micro ${by.slice(12)} đang dùng` : ({ windows_default: 'micro mặc định của Windows', selected: 'micro đã chọn', NO_MICROPHONE_FOUND: 'không thấy micro nào' } as Record<string, string>)[by] ?? by;
const megabytes = (bytes: number) => Math.round(bytes / 1048576);
const GLOSSARY_HELP = `pma glossary                      xem bảng tên
pma glossary add <Tên đúng> --variants "nghe sai 1,nghe sai 2"   thêm cách ASR hay nghe sai một tên
pma glossary remove <Tên đúng>    xoá tên khỏi bảng
Bảng chỉ đổi cách hiển thị ("MISA (nghe: mì da)"), không sửa chữ gốc. Biến thể quá ngắn, là từ thông dụng
(vd. "Ta") hoặc đã thuộc tên khác sẽ bị từ chối; thêm --force nếu chắc chắn.`;

// The meeting's audio folder (its screen/ watcher output gives speaker names) and the names for the lines being printed.
let AUDIO_DIR: string | undefined;
let SPEAKERS = new Map<number, string>();
function line(item: any) {
  if (item.origin === 'system_gap') return `#${item.id} [KHOẢNG TRỐNG] ${item.text}`;
  // Câu ảo khi im lặng chỉ để lại số đoạn, không đưa chữ vào để Claude không đọc nhầm thành nội dung.
  if (isHallucination(item)) return `#${item.id} [bỏ: nghi câu ảo]`;
  const flags = Object.entries(FLAG_LABELS).filter(([code]) => item.boundary?.includes(code)).map(([, label]) => label);
  // Microphone: the owner. Otherwise the tile Zoom outlined as speaking (tools/meeting_screen.ps1), in brackets.
  const who = micLabel(item.boundary) ? ' ' + micLabel(item.boundary) : SPEAKERS.has(item.id) ? ` [${SPEAKERS.get(item.id)}]` : '';
  // The other Lao/Thai reading of an unsure chunk, for the translation session to read both (owner 31/10).
  const others = (item.alternatives ?? []).map((a: any) => `\n  ↳ ${a.language}: ${a.text}`).join('');
  const translated = item.translation ? `\n  → (Claude dịch) ${item.translation}` : '';
  return `#${item.id} ${clock(item.wall || item.createdAt)}${who} ${item.language || '?'}${flags.length ? '⚠' + flags.join(',') : ''}: ${item.shown ?? item.text}${others}${translated}`;
}
// Ba đoạn ngắn giống nhau trở lên (vòng lặp ASR) in thành một dòng.
// A group keeps the mic label (foldRuns never joins different ones): `#3–#5 Tôi (mic bật) lặp ×3: …`.
const lines = (items: any[]) => (SPEAKERS = speakersOf(items, screenEvents(AUDIO_DIR), item => !!micLabel(item.boundary), loadNames(AUDIO_DIR)), foldRuns(items)).map(g => g.count > 1 ? `#${g.first.id}–#${g.last.id}${micLabel(g.first.boundary) ? ' ' + micLabel(g.first.boundary) : ''} lặp ×${g.count}: ${g.first.shown ?? g.first.text}` : line(g.first));

function agenda(flags: Record<string, string>) { return flags['agenda-file'] ? readFileSync(flags['agenda-file'], 'utf8') : flags.agenda; }
function languagesOf(flags: Record<string, string>) { return flags.languages ? flags.languages.split(',').map(v => v.trim()) : undefined; }

// A role already followed by another live process is waited for (every 5 s, up to 100 s), then given up. Env: tests shorten both.
const BUSY_RETRY_MS = Number(process.env.PMA_FOLLOW_RETRY_MS || 5000); const BUSY_MAX_MS = Number(process.env.PMA_FOLLOW_BUSY_MAX_MS || 100000);
const isBusy = (error: unknown) => /FOLLOWER_BUSY/.test(String((error as any)?.message ?? error));
const isGone = (error: unknown) => /SESSION_NOT_ACTIVE|SESSION_NOT_FOUND/.test(String((error as any)?.message ?? error));

async function follow(flags: Record<string, string>) {
  // 15 s by default: the 60 s batches of 29–30/10 made Claude's answers lag the meeting by a minute or more.
  const batchMs = Number(flags.batch || 15) * 1000; const maxLines = Number(flags.max || 40);
  let status = await call('status');
  if (!status.session || status.session.ended) { out({ error: 'NO_ACTIVE_SESSION' }); process.exitCode = 1; return; }
  if (flags.session && flags.session !== status.session.id) { out({ error: 'SESSION_NOT_ACTIVE', hint: 'follow chỉ theo phiên đang mở' }); process.exitCode = 1; return; }
  // This process follows this meeting only: every call names it, so once it ends and another one opens, the old follower never
  // reads, claims or acknowledges the new meeting (the host refuses an ID that is not the open session).
  const sessionId: string = status.session.id;
  AUDIO_DIR = status.audio?.dir;
  const name = flags.as ?? 'chinh';
  if (!/^[a-z0-9-]{1,24}$/.test(name)) { out({ error: 'INVALID_FOLLOWER_NAME', hint: '--as chỉ gồm a-z, 0-9, dấu gạch ngang, tối đa 24 ký tự' }); process.exitCode = 1; return; }
  // One lease per process: it is what keeps two followers of the same role from printing the same lines twice.
  const lease = randomBytes(12).toString('hex');
  // Resume where this follower's work is saved (committed), not only where it had printed to: rows printed but never translated or
  // put in the picture come again. A new one starts at the main cursor (what the main follower has read).
  const resumeAt = (s: any) => s.followers?.[name]?.committed ?? s.followers?.[name]?.cursor ?? s.agentCursor;
  // `after`: scanned up to here (hidden lines included). `batch`: visible lines not yet printed. `ack` sent to the host is ackOf(batch, after).
  let after = flags.after ? Number(flags.after) : resumeAt(status);
  let batch: any[] = []; let batchStarted = 0; let state = status.captureState; let failures = 0; let laoWarned = false;
  // Monitor ends a command after 30 minutes; leaving at 29 on our own terms tells Claude to start the same command again.
  const followStarted = Date.now(); const followMs = Number(flags.minutes || 29) * 60000;
  // A side follower (the raw translation session) hands a batch over as soon as it holds a Lao/Thai line.
  const taiNow = name !== 'chinh' && flags['tai-now'] !== 'false';
  console.log(`FOLLOWING ${name} "${status.session.title}" từ #${after} · lô ${batchMs / 1000}s · trạng thái ${state}`);
  // A replay is one mixed file: the user's microphone cannot be told from the speakers, so a share role gets no text from it (host side).
  if (name !== MAIN && status.replay) console.log('GIỚI HẠN: đang phát lại file đã trộn — không tách được tiếng micro của người dùng khỏi loa, nên chữ không được chiếu ở vai này.');
  const flush = () => {
    if (!batch.length) return;
    console.log(`LÔ #${batch[0].id}–#${batch.at(-1).id} (${batch.length} đoạn):`);
    // Once per follow: Lao heard without the Lao model is a Thai-script transliteration (owner + Oanh 21/11).
    if (!laoWarned && batch.some(item => item.boundary?.includes('LAO_MODEL_MISSING'))) { laoWarned = true; console.log('CẢNH BÁO TIẾNG LÀO: máy chưa có mô hình Lào, lời Lào đang ra chữ Thái PHIÊN ÂM, nghĩa, số và tên không đáng tin. Báo người dùng; sau họp dựng mô hình (pma doctor chỉ cách) rồi pma recheck các dòng này.'); }
    for (const text of lines(batch)) for (const part of wrapLine(text)) console.log(part);
    // The synthesis session keeps the whole meeting in view: after each batch it rewrites the picture, not a batch summary.
    if (name === MAIN && flags['no-notes'] !== 'true') console.log(`CẬP NHẬT BỨC TRANH tới #${batch.at(-1).id}: chỉ gửi phần mới/sửa (đã chốt · việc–người–hạn · số liệu · câu hỏi; sửa thì ghi cũ → mới, có nguồn) và thay phần đang bàn: pma picture update --file - --base <bản hiện tại> --receipt <biên nhận brief>; trả lời người dùng chỉ phần mới.`);
    batch = [];
  };
  // Gives the role back before the process ends (and before BẬT LẠI is printed, so the next process finds it free). Errors do not matter.
  const leave = () => call('release', { sessionId, as: name, lease, ack: ackOf(batch, after) }, 5000).catch(() => {});
  // Claims the role (a next call that only carries the lease). Busy: say so once, retry, give up after BUSY_MAX_MS. A claim after a wait
  // starts from the cursor the other process left, not from the one this process read before waiting.
  const acquire = async (first: boolean) => {
    const waitStarted = Date.now(); let told = false; let errors = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        if (!(first && (attempt === 0 || flags.after))) { const s = await call('status'); if (s.session?.id !== sessionId || s.session?.ended) return 'ended'; after = resumeAt(s); }
        await call('next', { sessionId, after, ack: after, waitMs: 0, limit: 1, follower: true, as: name, lease }, 15000); return true;
      }
      catch (error) {
        if (isGone(error)) return 'ended';
        if (!isBusy(error)) { if (++errors >= 5) throw error; await new Promise(r => setTimeout(r, 3000)); continue; }
        if (!told) { told = true; console.log(`CHỜ: vai ${name} đang có tiến trình theo dõi khác`); }
        if (Date.now() - waitStarted >= BUSY_MAX_MS) return false;
        await new Promise(r => setTimeout(r, BUSY_RETRY_MS));
      }
    }
  };
  const giveUp = async () => { await leave(); console.log(`DỪNG: vai ${name} vẫn đang có tiến trình theo dõi khác sau ${Math.round(BUSY_MAX_MS / 1000)} giây`); process.exitCode = 1; };
  // A share role that comes back to more than --max printable lines does not replay them all: the oldest are dropped on purpose and
  // named by number only; the synthesis session has them. "chinh" never skips.
  const catchUp = async () => {
    if (name === MAIN) return;
    const pending: number[] = [];
    for (let from = after; ;) { const page = await call('read', { sessionId, after: from, limit: 100, as: name }); pending.push(...page.items.map((item: any) => item.id)); from = page.nextCursor; if (page.done) break; }
    if (pending.length > maxLines) { const cut = pending.length - maxLines; console.log(`BỎ QUA #${pending[0]}–#${pending[cut - 1]}: quá cũ để chiếu lại (đọc ở phiên tổng hợp)`); after = pending[cut - 1]; }
  };
  // Sau mỗi lô: báo khi chữ ra chậm hơn lời nói, và nhắc ghi chú cuốn chiếu mỗi 10 phút nghe.
  let lastReminder = 0; let lastCheck = 0; let micDevice: string | undefined; let micChanged: string | undefined; let micError: string | undefined; let recorderError: string | undefined;
  // What the meeting window showed since the last check (share on/off, frames): the synthesis session only. Starts at the end of
  // what is already there, so a restarted follow does not replay the morning.
  let screenSeen = name === MAIN ? screenEvents(AUDIO_DIR).length : 0;
  const checkScreen = () => {
    if (name !== MAIN || !AUDIO_DIR) return;
    const events = screenEvents(AUDIO_DIR);
    for (const event of events.slice(screenSeen)) {
      const text = screenLine(event, AUDIO_DIR);
      if (text) console.log(text);
    }
    screenSeen = events.length;
  };
  const checkHealth = async () => {
    lastCheck = Date.now();
    checkScreen();
    const s = await call('status').catch(() => null); if (!s) return;
    if (s.recorder?.error && s.recorder.error !== recorderError) { recorderError = s.recorder.error; console.log(`GHI ÂM ${s.recorder.state}: ${s.recorder.error}`); }
    // The context changed (participants or agenda added): bind again by itself, and say so once.
    contextCheck(s);
    // The central session gives each waiting question its one reminder; expired ones are parked by the host.
    if (name === MAIN) { const q = await call('questions', { sessionId }).catch(() => null); for (const item of q?.due ?? []) console.log(`NHẮC HỎI #${item.id}: ${item.text} (nhắc một lần; không trả lời thì đưa vào Câu hỏi mở)`); }
    if (s.captureState !== 'LISTENING') return;
    const info = s.captureInfo ?? {};
    if (info.micDevice && info.micDevice !== micDevice) { micDevice = info.micDevice; console.log(`MICRO TÔI: đang thu ${info.micDevice} (${micWhy(info.micSelectedBy)})`); }
    if (info.micError && info.micError !== micError) { micError = info.micError; console.log(`MICRO TÔI: không mở được micro, chỉ nghe loa (${info.micError})`); }
    if (info.micDeviceChanged && info.micDeviceChanged.to !== micChanged) { micChanged = info.micDeviceChanged.to; console.log(`MICRO TÔI ĐỔI: ứng dụng họp (${info.micDeviceChanged.app}) đang dùng "${info.micDeviceChanged.to}", máy vẫn thu "${info.micDeviceChanged.from ?? micDevice}". Muốn theo micro mới: pma pause rồi pma listen.`); }
    if (info.audioSaveError) console.log(`LƯU ÂM THANH LỖI: ${info.audioSaveError}`);
    const lag = s.captureInfo?.lagSeconds;
    const stalled = s.captureInfo?.asrStalledSeconds;
    if (typeof stalled === 'number') console.log(`BỘ NGHE ĐỨNG: ${stalled} giây chưa ra kết quả nào (con số trễ đang hiện là số cũ). Âm thanh vẫn được ghi. Kiểm việc nặng khác đang dùng GPU, nhất là một host PMA thứ hai; pma pause/listen không giúp khi GPU đầy.`);
    else if (typeof lag === 'number' && lag > LAG_WARN_SECONDS) console.log(`CẢNH BÁO TRỄ: chữ đang ra chậm ${Math.round(lag)} giây so với lời nói. Dừng việc nặng đang chạy trên máy.`);
    const since = Math.max(Date.parse(s.lastNoteAt ?? '') || 0, Date.parse(s.captureInfo?.listeningSince ?? '') || 0);
    if (flags['no-notes'] !== 'true' && since && Date.now() - since > NOTE_EVERY_MS && Date.now() - lastReminder > NOTE_EVERY_MS) { lastReminder = Date.now(); console.log(`NHẮC GHI CHÚ: đã hơn 10 phút bức tranh cuộc họp chưa được cập nhật. Cập nhật ngay: pma picture update --file - --base <bản hiện tại> --receipt <biên nhận brief>`); }
  };
  const ended = async () => { flush(); await leave(); console.log('KẾT THÚC: phiên đã đóng'); };
  const claimed = await acquire(true).catch(error => { console.log(`DỪNG: không gọi được runtime (${error})`); process.exitCode = 1; return 'failed' as const; });
  if (claimed === 'failed') return;
  if (claimed === 'ended') return ended();
  if (!claimed) return giveUp();
  await catchUp();
  // The context receipt is the agent reading `pma brief --as <role>` (ENG-45); follow only says when that reading is missing or old, once
  // per context version. It never acknowledges for the agent.
  let toldContext = '';
  const contextCheck = (s: any) => {
    const ctx = s?.followers?.[name]?.context; if (!ctx || ctx.state === 'READY' || ctx.state === 'DEGRADED' || ctx.state === 'NOT_READY' && ctx.reasons?.includes('ASR_NOT_LISTENING')) return;
    const key = `${s.context?.version}:${ctx.state}`; if (key === toldContext) return; toldContext = key;
    console.log(`CONTEXT ${ctx.reasons?.includes('STALE_CONTEXT') ? 'ĐỔI' : 'CHƯA ĐỌC'} (v${s.context?.version}, ${ctx.state}): chạy pma brief --as ${name}`);
  };
  contextCheck(await call('status').catch(() => null));
  for (;;) {
    let reply: any;
    // With a batch pending, wait no longer than what is left of its window.
    const waitMs = batch.length ? Math.max(200, batchMs - (Date.now() - batchStarted)) : 20000;
    try { reply = await call('next', { sessionId, after, ack: ackOf(batch, after), waitMs: Math.min(20000, waitMs), limit: 100, follower: true, as: name, lease }, 40000); failures = 0; }
    catch (error) {
      // The meeting ended between two calls (or another one is open now): print what is held, release, stop.
      if (isGone(error)) return ended();
      // Another process took the role while this one was away (a sleeping machine): what it holds is the new owner's to deliver.
      if (isBusy(error)) {
        batch = []; const again = await acquire(false).catch(() => 'failed' as const);
        if (again === 'ended') return ended(); if (again === 'failed') { console.log('DỪNG: không gọi được runtime'); process.exitCode = 1; return; }
        if (!again) return giveUp(); await catchUp(); continue;
      }
      if (++failures >= 5) { flush(); await leave(); console.log(`DỪNG: không gọi được runtime (${error})`); process.exitCode = 1; return; }
      await new Promise(r => setTimeout(r, 3000)); continue;
    }
    // A state change is reported before the text that arrived with it.
    if (reply.captureState !== state) {
      flush(); state = reply.captureState;
      const s = await call('status').catch(() => null);
      console.log(`TRẠNG THÁI ${state}${s?.lastError ? ': ' + s.lastError : ''}${state === 'OFF' && s?.replay ? ' (phát lại đã hết)' : ''}`);
    }
    if (reply.items.length) { if (!batch.length) batchStarted = Date.now(); batch.push(...reply.items); }
    after = reply.nextCursor;  // scanned, hidden lines too; what the host is told is acknowledged is ackOf(batch, after)
    if (reply.ended) return ended();
    if (batch.length && (batch.length >= maxLines || Date.now() - batchStarted >= batchMs || (taiNow && batch.some(item => item.language === 'lo' || item.language === 'th')))) { flush(); await checkHealth(); }
    else if (Date.now() - lastCheck > 30000) await checkHealth();
    if (Date.now() - followStarted > followMs) {
      flush(); await leave();
      console.log(`BẬT LẠI: theo dõi đã chạy ${Math.round(followMs / 60000)} phút (Monitor giới hạn 30 phút). Bật lại ngay Monitor với đúng lệnh: pma follow${flags.batch ? ' --batch ' + flags.batch : ''}${name !== 'chinh' ? ' --as ' + name : ''}${flags['no-notes'] === 'true' ? ' --no-notes' : ''}`);
      return;
    }
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = options(rest);
  const session = flags.session ? { sessionId: flags.session } : {};
  switch (command) {
    case 'start': {
      // The participants file is read first: a bad file stops here, before any session exists.
      const listed = flags.participants ? jsonOf(flags.participants, 'danh sách người dự') : undefined;
      // The machine must serve the meeting (owner 21/11, tools/hardware.py): not enough hardware, or Lao wanted where the Lao model
      // cannot run or is not installed, refuses here, before any session or recording exists.
      const hw = hardwareVerdict(languagesOf(flags) ?? ['vi', 'lo', 'th']);
      if (hw && (hw.tier === 'khong-du' || hw.tier === 'unknown' || hw.meeting?.ok === false)) {
        const lao = (hw.meeting?.refused ?? []).includes('lo');
        const hint = hw.tier === 'unknown' ? 'pma doctor để xem thiếu gì'
          : hw.tier === 'khong-du' ? 'máy không đủ cho họp trực tiếp (xem bảng: pma hardware); dùng máy khác'
          : lao && hw.tier === 'day-du' ? 'máy đủ nhưng chưa cài mô hình Lào: sh tools/setup_lao_gpu.sh; họp không có tiếng Lào thì thêm --languages vi,th'
          : 'máy chỉ đủ tiếng Việt: họp không có tiếng Lào thì thêm --languages vi (lời Lào sẽ ra chữ Thái phiên âm, không đáng tin)';
        out({ error: 'HARDWARE_NOT_ENOUGH', tier: hw.tier, label: hw.label, reasons: hw.reasons ?? [hw.error], refusedLanguages: hw.meeting?.refused ?? [], hint });
        process.exitCode = 1; return;
      }
      const status = await call('prepare', { title: flags.title, agenda: agenda(flags), languages: languagesOf(flags), me: flags.me, at: flags.at, ...(flags['no-mic'] === 'true' ? { mic: false } : {}), ...(flags.purpose !== undefined ? { purpose: flags.purpose === 'true' ? '' : flags.purpose } : {}) });
      // Right after the session exists; a list the runtime refuses is reported, the session stays open.
      const people = listed ? await attach('participants', { participants: listed }).catch(error => ({ error: String(error?.message ?? error) })) : undefined;
      const opened = flags.link ? await call('open', { url: flags.link }) : undefined;
      const load = status.expectedLoadSeconds ? `, lần trước mất khoảng ${Math.round(status.expectedLoadSeconds)} giây` : '';
      // The recorder starts by itself when the speaker of the last session is still there (profile.json): pma status shows recorder.state.
      const source = status.rememberedSpeaker ? `Đang dò nguồn loa đã nhớ từ lần trước ("${status.rememberedSpeaker}"): nếu còn thì bộ ghi âm tự chạy (pma status → recorder.state RECORDING), không cần select; nếu không: pma sources → hỏi người dùng → pma select <index> (bắt đầu ghi âm cả buổi). Rồi pma listen → Monitor "pma follow"` : 'pma sources → hỏi người dùng → pma select <index> (bắt đầu ghi âm cả buổi) → pma listen → Monitor "pma follow"';
      return out({ ...status, opened, ...(people ? { participants: people } : {}), next: `Mô hình đang nạp sẵn, chữ chưa chạy tới khi pma listen (WARMING${load}). ${source} (micro "Tôi" luôn ghi)` + (status.me ? '' : '. Chưa biết tên người dùng: thêm --me "Tên" ở lần start sau.') });
    }
    case 'participants': {
      if (!flags.file) throw new Error('pma participants --file p.json');
      const people = jsonOf(flags.file, 'danh sách người dự');
      return saved('danh sách người dự', await attach('participants', { participants: people, ...(flags.key ? { idempotencyKey: flags.key } : {}) }), { label: 'participants' });
    }
    // The meeting procedure belongs to the tool and its version; the hop skill of any project only points here (owner 10/11).
    case 'guide': return process.stdout.write(guide(positional[0]));
    // Recordings to text on this machine (tools/transcribe_recording.py): WhatsApp voice notes, app recordings, meeting files.
    // Not a meeting: no host, no session. Owner 21/11 (for Lê Hoàng Duy). Default output: <first file>-chu.md next to it.
    case 'transcribe': {
      if (!positional.length) throw new Error('pma transcribe <file…> [--out f.md] [--title T] [--languages vi,lo,th]');
      const outFile = flags.out || positional[0].replace(/\.[^./\\]+$/, '') + '-chu.md';
      const done = spawnSync(venvPython(), ['-I', `${ROOT}/tools/transcribe_recording.py`, ...positional, '--out', outFile, '--title', flags.title || positional.map(f => f.split(/[\\/]/).pop()).join(', '), ...(flags.languages ? ['--languages', flags.languages] : [])], { stdio: 'inherit' });
      if (done.error) { console.log(`THIẾU python: ${done.error.message} → pma doctor`); process.exitCode = 1; return; }
      if (done.status === 0) console.log(`CHỮ: ${outFile}  (chưa xác minh; lời Lào/Thái do Claude dịch khi đọc file này)`);
      process.exitCode = done.status ?? 1; return;
    }
    // The hardware table and this machine's tier (tools/hardware.py, read only): what to install, which languages a meeting may use.
    case 'hardware': {
      const done = spawnSync(venvPython(), ['-I', `${ROOT}/tools/hardware.py`, ...(flags.json ? ['--json'] : []), ...(flags.languages ? ['--languages', flags.languages] : [])], { stdio: 'inherit' });
      if (done.error) { console.log(`THIẾU python: không chạy được (${done.error.message}) → tạo .venv theo README`); process.exitCode = 1; return; }
      process.exitCode = done.status ?? 1; return;
    }
    // What this machine has for the meeting tool (tools/doctor.py, read-only): the same list on every machine.
    case 'doctor': {
      const python = venvPython();
      const done = spawnSync(python, ['-I', `${ROOT}/tools/doctor.py`, '--project', flags.project || process.cwd(), ...(flags.json ? ['--json'] : [])], { stdio: 'inherit' });
      if (done.error) { console.log(`THIẾU python: không chạy được ${python} (${done.error.message}) → tạo .venv theo README`); process.exitCode = 1; return; }
      process.exitCode = done.status ?? 1; return;
    }
    case 'purpose': {
      const value = positional.join(' ') || (flags.purpose && flags.purpose !== 'true' ? flags.purpose : '');
      if (!value) throw new Error('PURPOSE_NEEDS_VALUE: pma purpose thong-bao | huong-dan | giao-viec | ban-quyet-dinh (hoặc: thông báo, hướng dẫn, giao việc, bàn quyết định)');
      const r = await call('purpose', { ...session, purpose: value });
      return out({ ...r, line: r.changed ? `MỤC ĐÍCH HỌP: ${r.label}${r.was ? ' (trước đó: ' + r.was + ')' : ''} — ${r.rule}. Context đổi sang v${r.version}: chạy lại pma brief --as chinh trước khi lưu bức tranh/SUMMARY/TASKS` : `MỤC ĐÍCH HỌP: ${r.label} (không đổi)` });
    }
    case 'brief': { const r = await call('brief', { ...session, ...(flags.as ? { as: flags.as } : {}) }); return process.stdout.write(r.markdown); }
    // The running picture of the whole meeting (synthesis session): read it, or save a new version from a file.
    case 'picture': {
      if (positional[0] === 'update') {
        if (!flags.file) throw new Error('SAVE_NEEDS_FILE: pma picture update cần --file <f.json> hoặc --file - (đọc stdin) với JSON {"add":[…],"fix":[…],"dangBan":"…"}. Chưa lưu gì');
        if (flags.sources !== undefined) throw new Error('SOURCES_IN_JSON: pma picture update không có --sources; nguồn nằm trong JSON (sourceIds của từng mục; bản chỉ có dangBan thì thêm "sourceIds" ở cấp ngoài). Chưa lưu gì');
        const r = await attach('pictureUpdate', { ...session, update: jsonOf(flags.file, 'bản cập nhật bức tranh'), ...draftFlags(flags) });
        const part = [r.added?.length ? 'thêm ' + r.added.map((a: any) => a.id).join(', ') : '', r.fixed?.length ? 'sửa ' + r.fixed.map((f: any) => `${f.targetId}→${f.newId}`).join(', ') : '', r.skipped?.length ? 'bỏ qua trùng ' + r.skipped.join(', ') : ''].filter(Boolean).join('; ');
        return saved('bức tranh (cập nhật' + (part ? ': ' + part : '') + ')', r, { sourceIds: [] });
      }
      if (!flags.file) {
        const stray = SAVE_ONLY_FLAGS.filter(key => flags[key] !== undefined);
        if (stray.length) throw new Error(`SAVE_NEEDS_FILE: ${stray.map(key => '--' + key).join(' ')} chỉ dùng khi LƯU bức tranh, mà thiếu --file <f.md> hoặc --file - (đọc stdin). Chưa lưu gì; bản hiện tại giữ nguyên. Muốn đọc bức tranh thì chạy pma picture không kèm cờ nào`);
      } else {
        const text = contentOf(flags.file, 'bức tranh'); const sourceIds = sourcesOf(flags, 'bức tranh');
        return saved('bức tranh', await attach('picture', { ...session, text, sourceIds, ...draftFlags(flags) }), { chars: text.length, sourceIds });
      }
      if (flags.json === 'true') return out(await call('picture', { ...session, items: true }));
      const p = await call('picture', session);
      if (!p) return console.log('Chưa có bức tranh cuộc họp (pma picture update --file - --base 0 --receipt rcpt-…)');
      // A big picture is read in whole pages (nothing cut or left out): a short one prints exactly as before.
      const pages = pagesOf(p.text); const head = `# Bức tranh cuộc họp (bản ${p.revision}, ${clock(p.savedAt)})\n\n`;
      const wanted = flags.page === undefined ? 1 : flags.page === 'all' ? 0 : Number(flags.page);
      if (!Number.isInteger(wanted) || wanted < 0 || wanted > pages.length) throw new Error(`PAGE_OUT_OF_RANGE: bức tranh có ${pages.length} trang; dùng --page 1..${pages.length} hoặc --page all`);
      if (pages.length === 1 || wanted === 0) return console.log(head + (wanted === 0 ? pages.join('\n') : pages[0]));
      return console.log(`${head}[trang ${wanted}/${pages.length}]\n${pages[wanted - 1]}\n\n${wanted < pages.length ? `CÒN ${pages.length - wanted} TRANG: pma picture --page ${wanted + 1} (hoặc --page all). Chưa đọc hết thì chưa gộp/sửa mục ở trang chưa đọc.` : '[hết]'}`);
    }
    case 'me': {
      const chosen = (['on', 'off', 'auto'] as const).filter(v => flags[v] === 'true');
      if (chosen.length !== 1) throw new Error('pma me --on | --off | --auto (đúng một cờ)');
      const r = await call('mic', { state: chosen[0] });
      return out({ mic: r.entry.state === 'unknown' ? 'auto' : r.entry.state, by: 'manual', at: r.entry.t, timeline: r.path });
    }
    case 'at': return out(await call('schedule', { ...session, at: positional[0] ?? flags.at }));
    case 'sources': { const r = await call('sources', { levels: flags.levels !== 'false' }); return out({ suggested: r.suggested, devices: r.devices.map((d: any) => ({ index: d.index, name: d.name, kind: d.kind === 'microphone' ? 'mic' : 'speaker', default: d.isDefaultOutput || undefined, frames: d.level?.framesReceived, peak: d.level?.peak })) }); }
    case 'select': return out(await call('select', { ...session, deviceIndex: Number(positional[0]), ...micFlag(flags) }));
    // Micro "Tôi" is on by default (owner, 30/10/2026); select-mic only picks a different microphone.
    case 'select-mic': return out(await call('selectMic', { ...session, deviceIndex: Number(positional[0]), consent: true }));
    case 'listen': {
      await call('listen', { ...session, ...micFlag(flags) });
      // Model load took up to ~3 minutes on 30/10; wait for it instead of reporting a failure.
      const deadline = Date.now() + 300000; let status = await call('status');
      while (['WARMING', 'WARM_READY', 'LOADING_ASR', 'WAITING_FOR_SOURCE'].includes(status.captureState) && Date.now() < deadline) { await new Promise(r => setTimeout(r, 1500)); status = await call('status'); }
      return out({ captureState: status.captureState, lastError: status.lastError, recorder: status.recorder, device: status.armedDevice?.name, mic: status.captureInfo?.micDevice ?? undefined, micWhy: status.captureInfo?.micDevice ? micWhy(status.captureInfo.micSelectedBy) : status.captureInfo?.micError, modelLoadSeconds: status.captureInfo?.modelLoadSeconds, audio: status.audio ? { dir: status.audio.dir, note: 'Bản ghi âm cả buổi nằm trên máy này (WAV ~0,8 GB/giờ), giữ cho tới khi bạn tự xoá bằng pma audio purge; meeting-mix.wav được ghép khi pma stop' } : 'chưa có file âm thanh: bộ ghi âm chưa chạy (cần pma select <index> trước)', next: status.captureState === 'LISTENING' ? 'Monitor "pma follow"' : 'kiểm tra nguồn' });
    }
    case 'follow': return follow(flags);
    case 'job': {
      const action = positional[0];
      if (action === 'start') return out(await call('job', { ...session, action, title: positional.slice(1).join(' ') || flags.title, kind: flags.kind || 'analysis' }));
      if (action === 'done') {
        const id = Number(positional[1]); if (!Number.isInteger(id) || id < 1) throw new Error('JOB_NEEDS_ID: pma job done <id> --file kq.md --sources 1,2 --token job-…');
        const result = flags.file ? contentOf(flags.file, 'kết quả việc nền') : flags.text && flags.text !== 'true' ? flags.text : undefined;
        if (!result) throw new Error('JOB_NEEDS_RESULT: pma job done <id> cần kết quả: --file kq.md (hoặc --file -) hoặc --text "…". Chưa lưu gì');
        const sourceIds = sourcesOf(flags, 'kết quả việc nền', false);
        return saved(`kết quả việc nền #${id}`, await attach('job', { ...session, action, id: Number(positional[1]), result, sourceIds, ...(flags.token ? { token: flags.token } : {}) }), { chars: result.length, sourceIds });
      }
      if (action === 'fail') return out(await call('job', { ...session, action, id: Number(positional[1]), note: positional.slice(2).join(' ') || flags.note, ...(flags.token ? { token: flags.token } : {}) }));
      if (action === 'list' || !action) return out(await call('job', { ...session, action: 'list', ...(flags.status ? { status: flags.status } : {}) }));
      throw new Error('pma job start|done|fail|list');
    }
    case 'ask': return out(await call('ask', { ...session, text: positional.join(' ') || flags.text, sourceIds: list(flags.sources), ...(flags.ttl ? { ttl: Number(flags.ttl) } : {}) }));
    case 'answer': return out(await call('answer', { ...session, id: Number(positional[0]), text: positional.slice(1).join(' ') || flags.text }));
    case 'correct': return out(await call('correct', { ...session, raw: flags.raw, corrected: flags.to, ...(flags.source ? { sourceId: Number(flags.source) } : {}), basis: flags.confirmed === 'true' ? 'user_confirmed' : 'inferred', scope: flags.company === 'true' ? 'company' : 'meeting' }));
    case 'doc': return out(await call('doc', { ...session, label: flags.label, pointer: flags.pointer }));
    case 'grant': return out(await call('grant', { ...session, person: positional.join(' ') || flags.person, ...(flags.scope ? { scope: flags.scope } : {}), source: flags.source }));
    case 'propose': return out(await call('propose', { ...session, text: positional.join(' ') || flags.text, sourceIds: list(flags.sources) }));
    case 'decide': return out(await call('decide', { ...session, id: Number(positional[0]), by: flags.by, sourceIds: list(flags.sources), ...(flags.scope ? { scope: flags.scope } : {}) }));
    case 'change': return out(await call('decide', { ...session, id: Number(positional[0]), change: positional.slice(1).join(' ') || flags.text, by: flags.by, sourceIds: list(flags.sources), ...(flags.scope ? { scope: flags.scope } : {}) }));
    case 'withdraw': return out(await call('withdraw', { ...session, id: Number(positional[0]), by: flags.by, note: flags.note ?? '' }));
    case 'act': return out(await call('action', { ...session, step: 'plan', id: Number(positional[0]), text: positional.slice(1).join(' ') || flags.text }));
    case 'action': return out(await call('action', { ...session, step: positional[0], id: Number(positional[1]), text: positional.slice(2).join(' ') || flags.text }));
    case 'decisions': return out(await call('decisions', session));
    case 'seat': {
      if (positional[0] === 'list') return out(await call('seats', { ...session, expect: flags.expect ? flags.expect.split(',').map(v => v.trim()).filter(Boolean) : [] }));
      return out(await call('seat', { ...session, person: positional.join(' ') || flags.person, ...(flags.role ? { role: flags.role } : {}), ...(flags['role-desc'] ? { roleDescription: flags['role-desc'] } : {}), ...(flags.scope ? { scope: flags.scope } : {}), ...(flags.remote === 'true' ? { kind: 'remote_claude' } : {}) }));
    }
    case 'assign': return out(await call('assign', { ...session, person: positional[0] ?? flags.to, text: positional.slice(1).join(' ') || flags.text, sourceIds: list(flags.sources), ...(flags.decision ? { decisionId: Number(flags.decision) } : {}), ...(flags.due ? { due: flags.due } : {}) }));
    case 'role': return out(await call('role', { ...session, seat: flags.seat }));
    case 'accept': case 'decline': case 'reply': return out(await call('respond', { ...session, seat: flags.seat, step: command, id: Number(positional[0]), ...(positional.length > 1 || flags.text ? { text: positional.slice(1).join(' ') || flags.text } : {}), sourceIds: list(flags.sources), ...(flags.propose ? { propose: flags.propose } : {}) }));
    case 'converge': {
      if (positional[0] === 'promote') return out(await call('converge', { ...session, action: 'promote', id: Number(positional[1]) }));
      if (positional[0] === 'handle') return out(await call('converge', { ...session, action: 'handle', kind: positional[1], id: Number(positional[2]), by: flags.by, note: flags.note }));
      return out(await call('converge', session));
    }
    case 'questions': return out(await call('questions', session));
    case 'degraded': {
      if (positional[0] === 'clear') return out(await call('degraded', { ...session, action: 'clear', kind: positional[1] }));
      if (!positional[0]) return out(await call('degraded', { ...session, action: 'list' }));
      const r = await call('degraded', { ...session, action: 'mark', kind: positional[0], detail: positional.slice(1).join(' ') || flags.detail || '' });
      return out(r.first ? { ...r, report: `SUY GIẢM (${positional[0]}): báo người dùng một lần; phần khác vẫn chạy` } : r);
    }
    case 'say': return out(await call('manual', { ...session, text: flags.text === 'true' ? undefined : flags.text ?? (positional.join(' ') || undefined) }));
    case 'translate': {
      let items: any;
      if (flags.file) items = jsonOf(flags.file, 'bản dịch');
      else {
        if (!flags.source || !/^#?[1-9]\d*$/.test(flags.source)) throw new Error('TRANSLATE_NEEDS_SOURCE: pma translate --source <#id đoạn Lào/Thái> --text "tiếng Việt" (hoặc --file t.json). Chưa lưu gì');
        if (!flags.text || flags.text === 'true') throw new Error('TRANSLATE_NEEDS_TEXT: pma translate --source <#id> --text "tiếng Việt" (bản dịch đang rỗng). Chưa lưu gì');
        items = [{ sourceId: Number(flags.source.replace(/^#/, '')), text: flags.text }];
      }
      const lines: any[] = Array.isArray(items) ? items : [];
      return saved('bản dịch', await attach('translate', { ...session, items, ...(flags.key ? { idempotencyKey: flags.key } : {}) }), { chars: lines.reduce((n, item) => n + String(item?.text ?? '').length, 0), sourceIds: lines.map(item => item?.sourceId).filter(Number.isInteger) });
    }
    case 'status': return out(await inspect());
    case 'screen': {
      // The screen watcher of the open meeting (Zoom window, read only): who shares, who Zoom outlines as speaking, frames.
      const action = positional[0] || 'status';
      const s = await call('status');
      const dir: string | undefined = s.audio?.dir;
      const open = s.session && !s.session.ended && dir;
      if (action === 'start') {
        if (!open) { out({ error: 'NO_ACTIVE_SESSION', hint: 'pma screen start chạy cho cuộc họp đang mở' }); process.exitCode = 1; return; }
        return out(startWatcher(ROOT, dir, s.session.id, flags.interval));
      }
      // After the meeting (live 21/11 the watcher outlived `pma stop`): stop/status/name work on --session or the latest meeting's audio.
      let target: string | undefined = open && !flags.session ? dir : undefined;
      if (!target) {
        const meetings: any[] = await call('audio', { action: 'list' });
        const pick = flags.session ? meetings.find(m => m.sessionId === flags.session) : [...meetings].sort((a, b) => String(b.savedAt ?? '').localeCompare(String(a.savedAt ?? '')))[0];
        target = pick?.dir;
      }
      if (!target) { out({ error: 'NO_MEETING_AUDIO', hint: 'không thấy thư mục âm thanh của cuộc họp (--session ID)' }); process.exitCode = 1; return; }
      const dirFor = target;
      if (action === 'stop') return out(stopWatcher(dirFor));
      if (action === 'status') return out(screenStatus(dirFor));
      if (action === 'name') return out(saveName(dirFor, positional[1] ?? '', positional.slice(2).join(' ')));
      throw new Error('pma screen [start|stop|status|name "<tên máy đọc>" "<tên đúng>"] [--session ID]');
    }
    case 'pause': return out(await call('pause', session));
    case 'audio': {
      const action = positional[0] || 'list';
      if (action !== 'list' && action !== 'purge') throw new Error('pma audio [list | purge [--older-than N]]');
      const olderThanDays = flags['older-than'] !== undefined ? Number(flags['older-than']) : undefined;
      if (olderThanDays !== undefined && !(olderThanDays >= 0)) throw new Error('--older-than phải là số ngày (0 trở lên)');
      const r = await call('audio', { action, olderThanDays });
      if (action === 'list') return out(r.map((item: any) => ({ session: item.sessionId, title: item.title, dir: item.dir, files: item.files, mb: megabytes(item.bytes), expiresAt: item.expiresAt ?? 'không hết hạn', mix: [...item.mix, ...item.mixing.map(() => 'đang ghép')] })));
      return out({ removed: r.removed.length, kept: r.kept, freedMb: megabytes(r.freedBytes) });
    }
    // Stop = recorder stops, ASR drains, the mix is made, then RAW: minutes on a long meeting, so wait much longer than usual.
    case 'stop': { const r = await reach('finish', session, 20 * 60000); return out({ session: r.session, raw: r.raw, audio: r.audio?.mix, ...(r.unfinished?.length ? { unfinished: r.unfinished } : {}), ...(r.decisions?.length ? { decisions: r.decisions } : {}), next: 'pma coverage (chỗ chưa nghe rõ → pma recheck) → pma read → viết SUMMARY.md + tasks.json → pma summary / pma tasks' }); }
    case 'recheck': {
      const target = positional[0]?.replace(/^#/, ''); const sourceId = target ? Number(target) : undefined;
      if (target !== undefined && !Number.isInteger(sourceId)) throw new Error('pma recheck <#id> | --from HH:MM:SS --to HH:MM:SS');
      if (sourceId === undefined && !(flags.from && flags.to)) throw new Error('pma recheck <#id> | --from HH:MM:SS --to HH:MM:SS');
      const channel = flags.channel; const beam = flags.beam ? Number(flags.beam) : undefined;
      const extra = { ...(channel ? { channel } : {}), ...(beam ? { beam } : {}) };
      if (sourceId !== undefined) return out(await call('recheck', { ...session, sourceId, ...extra }, 15 * 60000));
      // A long range is heard in pieces of at most 5 minutes, one after another, each saved as it is done (BidOps 09–10/11: 10–20
      // minute ranges failed while 5–6 minute ones worked). One line of JSON per piece.
      for (const [from, to] of pieces(flags.from, flags.to, RECHECK_PIECE_SECONDS)) out(await call('recheck', { ...session, from, to, ...extra }, 15 * 60000));
      return;
    }
    case 'coverage': {
      const page = { ...(flags.after ? { after: Number(flags.after) } : {}), ...(flags.limit ? { limit: Number(flags.limit) } : {}) };
      const r = await call('coverage', { ...session, ...page }, 120000);
      if (flags.json) return out(r);
      // Text: the whole list, page after page (it used to stop at 200 of 385).
      for (let next = r.next; next !== null && next !== undefined;) { const more = await call('coverage', { ...session, after: next }, 120000); r.items.push(...more.items); next = more.next; }
      console.log(`ÂM THANH ${r.audio.seconds >= 60 ? Math.round(r.audio.seconds / 60) + ' phút' : r.audio.seconds + ' giây'} (xét theo ${r.audio.basis === 'mix' ? 'file ghép' : 'file loa'}) · cần nghe lại: ${r.open}/${r.total}`);
      if (r.note) console.log(`LƯU Ý: ${r.note}`);
      const KIND: Record<string, string> = { NO_TRANSCRIPT: 'CÓ TIẾNG NHƯNG KHÔNG CÓ CHỮ', ASR_GAP: 'KHOẢNG TRỐNG ASR', UNSURE: 'CHƯA CHẮC', RECORDER_LOST: 'BỘ GHI MẤT ÂM', RECORDER_ERROR: 'BỘ GHI LỖI' };
      for (const item of r.items) console.log(`[${item.fromClock}–${item.toClock}] ${KIND[item.kind] ?? item.kind}${item.sourceId ? ' #' + item.sourceId : ''}: ${item.why}${item.rechecked ? ' (đã nghe lại)' : ` → pma recheck ${item.sourceId ? '#' + item.sourceId : `--from ${item.fromClock} --to ${item.toClock}`}`}`);
      return console.log(r.total > r.items.length ? `CÒN ${r.total - r.items.length} mục nữa (xem --json)` : r.total ? 'HẾT DANH SÁCH' : 'KHÔNG CÓ CHỖ NÀO CẦN NGHE LẠI');
    }
    case 'read': {
      // Speaker names come from the screen watcher's file in that meeting's audio folder (data dir/audio/<session id>/screen).
      const st = await call('status').catch(() => null);
      const dir: string | undefined = st?.audio?.dir;
      AUDIO_DIR = dir && flags.session && st?.session?.id !== flags.session ? dir.replace(/[^\\/]+$/, flags.session) : dir;
      const r = await call('read', { ...session, after: Number(flags.after || 0), limit: Number(flags.limit || 100), ...(flags.as ? { as: flags.as } : {}) });
      if (flags.json) return out(r);
      for (const text of lines(r.items)) console.log(text);
      return console.log(r.done ? `HẾT (tới #${r.nextCursor})` : `CÒN TIẾP: pma read --after ${r.nextCursor}${flags.as ? ' --as ' + flags.as : ''}`);
    }
    case 'note': return out(await call('note', { ...session, key: flags.key || 'note-' + Date.now(), revision: Number(flags.revision || 1), kind: flags.kind || 'observation', text: flags.text, sourceIds: list(flags.sources) }));
    case 'summary': {
      const markdown = contentOf(flags.file, 'SUMMARY'); const sourceIds = sourcesOf(flags, 'SUMMARY');
      return saved('SUMMARY', await attach('summary', { ...session, markdown, sourceIds, ...draftFlags(flags) }), { chars: markdown.length, sourceIds });
    }
    case 'tasks': {
      const tasks = jsonOf(flags.file, 'TASKS');
      if (!Array.isArray(tasks)) throw new Error('TASKS_NOT_A_LIST: tasks.json phải là danh sách [{"task","owner?","due?","sourceIds":[…]}]. Chưa lưu gì');
      const sourceIds = tasks.flatMap((t: any) => Array.isArray(t?.sourceIds) ? t.sourceIds.filter(Number.isInteger) : []);
      const r = await attach('tasks', { ...session, tasks, ...draftFlags(flags) });
      return saved(`TASKS (${tasks.length} việc)`, r, { chars: JSON.stringify(tasks).length, sourceIds });
    }
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
      if (!status.session || status.session.ended) await call('prepare', { title: flags.title || 'Phát lại: ' + positional[0], agenda: agenda(flags), languages: languagesOf(flags), warm: false });
      await call('replay', { file: positional[0], speed: Number(flags.speed || 1) });
      return out({ replaying: positional[0], next: 'Monitor "pma follow"; khi báo phát lại đã hết: pma stop' });
    }
    case 'shutdown': return out(await call('shutdown'));
    default: console.log(USAGE); if (command && command !== 'help') process.exitCode = 1;
  }
}

main().catch(error => { out({ error: String(error?.message ?? error) }); process.exitCode = 1; });
