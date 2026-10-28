// `pma`: how Claude (or a person) drives the meeting runtime. Replies are compact JSON, except
// `follow` and `read`, which print transcript lines for Claude to read.
import { readFileSync } from 'node:fs';
import { call } from './client.js';

const USAGE = `pma — trợ lý họp chạy trên máy
  pma start [--title T] [--agenda TEXT | --agenda-file F] [--link ZOOM_URL] [--languages vi,lo]
  pma sources                      nguồn loa đang có tiếng (suggested)
  pma select <index>               cấp quyền nguồn loa (sau khi người dùng đồng ý)
  pma listen                       bật nghe, chờ tới LISTENING
  pma follow [--batch 60] [--max 40] [--after N]   in text mới theo lô, dùng với Monitor
  pma status | pause | stop        trạng thái / tạm dừng / kết thúc (ghi RAW.md)
  pma read [--after N] [--limit 100] [--session ID]
  pma note --text T --sources 1,2 [--kind observation]
  pma summary --file SUMMARY.md --sources 1,2,3 [--session ID]
  pma tasks --file tasks.json [--session ID]       [{"task","owner?","due?","sourceIds":[..]}]
  pma raw [--session ID] | history | context
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
const FLAG_LABELS: Record<string, string> = { LAO_WRITTEN_IN_THAI_SCRIPT: 'chữ Thái', LIKELY_HALLUCINATION: 'nghi ảo', REPETITION: 'lặp' };

function line(item: any) {
  if (item.origin === 'system_gap') return `#${item.id} [KHOẢNG TRỐNG] ${item.text}`;
  const flags = Object.entries(FLAG_LABELS).filter(([code]) => item.boundary?.includes(code)).map(([, label]) => label);
  return `#${item.id} ${clock(item.createdAt)} ${item.language || '?'}${flags.length ? '⚠' + flags.join(',') : ''}: ${item.text}`;
}

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
    console.log(`LÔ #${batch[0].id}–#${batch.at(-1).id} (${batch.length} đoạn): ` + batch.map(line).join(' ‖ '));
    batch = [];
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
    if (batch.length && (batch.length >= maxLines || Date.now() - batchStarted >= batchMs)) flush();
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = options(rest);
  const session = flags.session ? { sessionId: flags.session } : {};
  switch (command) {
    case 'start': {
      const status = await call('prepare', { title: flags.title, agenda: agenda(flags), languages: languagesOf(flags) });
      const opened = flags.link ? await call('open', { url: flags.link }) : undefined;
      return out({ ...status, opened, next: 'pma sources → hỏi người dùng → pma select <index> → pma listen → Monitor "pma follow"' });
    }
    case 'sources': { const r = await call('sources', { levels: flags.levels !== 'false' }); return out({ suggested: r.suggested, devices: r.devices.map((d: any) => ({ index: d.index, name: d.name, kind: d.kind === 'microphone' ? 'mic' : 'speaker', default: d.isDefaultOutput || undefined, frames: d.level?.framesReceived, peak: d.level?.peak })) }); }
    case 'select': return out(await call('select', { ...session, deviceIndex: Number(positional[0]) }));
    case 'listen': {
      await call('listen', session);
      const deadline = Date.now() + 90000; let status = await call('status');
      while (['LOADING_ASR', 'WAITING_FOR_SOURCE'].includes(status.captureState) && Date.now() < deadline) { await new Promise(r => setTimeout(r, 1500)); status = await call('status'); }
      return out({ captureState: status.captureState, lastError: status.lastError, device: status.captureInfo?.device, rms: status.captureInfo?.rms, next: status.captureState === 'LISTENING' ? 'Monitor "pma follow"' : 'kiểm tra nguồn' });
    }
    case 'follow': return follow(flags);
    case 'status': return out(await call('status'));
    case 'pause': return out(await call('pause', session));
    case 'stop': { const r = await call('finish', session); return out({ session: r.session, raw: r.raw, next: 'pma read → viết SUMMARY.md + tasks.json → pma summary / pma tasks' }); }
    case 'read': {
      const r = await call('read', { ...session, after: Number(flags.after || 0), limit: Number(flags.limit || 100) });
      if (flags.json) return out(r);
      for (const item of r.items) console.log(line(item));
      return console.log(r.done ? `HẾT (tới #${r.nextCursor})` : `CÒN TIẾP: pma read --after ${r.nextCursor}`);
    }
    case 'note': return out(await call('note', { ...session, key: flags.key || 'note-' + Date.now(), revision: Number(flags.revision || 1), kind: flags.kind || 'observation', text: flags.text, sourceIds: list(flags.sources) }));
    case 'summary': return out(await call('summary', { ...session, markdown: readFileSync(flags.file, 'utf8'), sourceIds: list(flags.sources) }));
    case 'tasks': return out(await call('tasks', { ...session, tasks: JSON.parse(readFileSync(flags.file, 'utf8')) }));
    case 'raw': return out(await call('raw', session));
    case 'history': return out(await call('history'));
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
