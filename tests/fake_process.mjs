// In-process fake processes for the runtime's process-control seams (0.12.x, late-exit fixtures). Nothing here spawns, signals or looks at
// a real process, opens a device or loads a model. Ownership rule the fixtures enforce: a fake keeps being ALIVE until the test calls
// exit(); a kill that was refused, ignored or only scheduled for later, a timeout, or a stale record never makes it dead. Only a real
// exit (exit(), possibly fired by the fake clock) does.
//
// Three pieces:
//   fakeClock()    a clock the test advances by hand; it fires the late exits scheduled on it, in order.
//   fakeProc(...)  a process known only by its PID: the runtime reaches it through runtime.alive(pid) and runtime.killPid(pid)
//                  (an "attached" recorder, a `pma follow` process). { pid, alive(), exit(code), kills: [], killPid(pid) } and more.
//   fakeChild(...) a ChildProcess-like object for runtime.recorder.child / runtime.capture: stdin.write, kill, exitCode/signalCode and
//                  the 'exit' then 'close' events. It ends only when told, or when a (late) kill fires on the fake clock.
// Plus attachFakeRecorder / attachFakeWorker (wire a fake child to the runtime the way spawnRecorder / spawnWorker do, without spawning),
// installSeams (point runtime.alive / runtime.killPid at the fake PIDs) and guardOsKill (proves no fake PID ever reached process.kill).
import { EventEmitter } from 'node:events';

const FAKE_PID_BASE = 2_000_000_000;   // far above any real PID on the machine (still a plain integer)
let nextPid = FAKE_PID_BASE;
export const FAKE_PIDS = new Set();
export const fakePid = () => { const pid = ++nextPid; FAKE_PIDS.add(pid); return pid; };
function registerPid(pid) {
  if (!Number.isInteger(pid) || pid < FAKE_PID_BASE || pid === process.pid) throw new Error('fake_process: a fake PID must be an integer >= ' + FAKE_PID_BASE + ' and never this process: ' + pid);
  FAKE_PIDS.add(pid); return pid;
}
const oserror = (code, message) => Object.assign(new Error(message), { code });

// A clock the test controls. `after(ms, fn)` schedules fn at now+ms; advance(ms) runs everything that falls due, in time order.
export function fakeClock(start = Date.parse('2026-11-03T08:00:00Z')) {
  let t = start; let seq = 0; let timers = [];
  const clock = {
    now: () => t,
    after(ms, fn) { const timer = { at: t + ms, fn, seq: seq++ }; timers.push(timer); return timer; },
    cancel(timer) { timers = timers.filter(x => x !== timer); },
    pending: () => timers.length,
    advance(ms) {
      const to = t + ms;
      for (;;) {
        const due = timers.filter(x => x.at <= to).sort((a, b) => a.at - b.at || a.seq - b.seq)[0]; if (!due) break;
        timers = timers.filter(x => x !== due); t = due.at; due.fn();
      }
      t = to;
    },
  };
  return clock;
}

// What a kill does. 'refuse': killPid throws EPERM (child.kill returns false); 'ignore': accepted, the process goes on; 'late': accepted,
// and the process really exits `lateMs` later on the fake clock; 'throw': child.kill throws EPERM (killPid is the same as 'refuse').
const KILL_MODES = ['refuse', 'ignore', 'late', 'throw'];
function checkKillOptions(kill, clock, lateMs) {
  if (!KILL_MODES.includes(kill)) throw new Error('fake_process: kill must be one of ' + KILL_MODES.join(', '));
  if (kill === 'late' && (!clock || !Number.isFinite(lateMs) || lateMs < 0)) throw new Error('fake_process: kill "late" needs a clock and lateMs');
}

// A process known only by its PID. Use installSeams(runtime, [proc]) to reach it as runtime.alive / runtime.killPid.
//   liveness: proc.unknown('throw' | 'undefined') makes alive() unreadable (it throws EIO / answers undefined); proc.known() restores it.
//   Even while unreadable the process is really alive or not (state), as a real one would be: only the reading is lost.
export function fakeProc({ pid = fakePid(), clock = null, kill = 'refuse', lateMs = 0, onExit = null } = {}) {
  registerPid(pid); checkKillOptions(kill, clock, lateMs);
  let exited = false; let reading = 'known'; let scheduled = null;
  const proc = {
    pid, kills: [], aliveCalls: 0, foreign: [], exitCode: null, kill, lateMs,
    get exited() { return exited; },
    // The runtime asks through the seam with the PID it holds; any other PID is recorded as foreign (the test asserts there are none).
    alive(asked = pid) {
      proc.aliveCalls++;
      if (asked !== pid) { proc.foreign.push({ call: 'alive', pid: asked }); throw new Error('fake_process: alive() asked about ' + asked + ', not the fake ' + pid); }
      if (reading === 'throw') throw oserror('EIO', 'fake_process: liveness unreadable');
      if (reading === 'undefined') return undefined;
      return !exited;
    },
    killPid(asked) {
      proc.kills.push({ pid: asked, at: Date.now(), clockAt: clock?.now() ?? null });
      if (asked !== pid) { proc.foreign.push({ call: 'killPid', pid: asked }); throw new Error('fake_process: killPid() on ' + asked + ', not the fake ' + pid); }
      if (exited) throw oserror('ESRCH', 'fake_process: no such process');   // what the OS answers for a process that is gone
      if (kill === 'refuse' || kill === 'throw') throw oserror('EPERM', 'fake_process: kill refused');
      if (kill === 'late' && !scheduled) scheduled = clock.after(lateMs, () => proc.exit(null));
    },
    // The process really ends. Returns false when it had ended already. Nothing else ends it.
    exit(code = 0) {
      if (exited) return false;
      exited = true; proc.exitCode = code; if (scheduled) { clock.cancel(scheduled); scheduled = null; }
      onExit?.(code); return true;
    },
    unknown(how = 'throw') { if (how !== 'throw' && how !== 'undefined') throw new Error('fake_process: unknown() takes throw or undefined'); reading = how; },
    known() { reading = 'known'; },
  };
  return proc;
}

// A ChildProcess-like object: pid, stdin.write (records lines), kill, exitCode/signalCode, stdout/stderr (so the runtime waits for
// 'close' as it does for a real child), and the events 'exit' then 'close'. It ends only through exit() (or a late kill on the clock).
//   stopExits: true makes it end 10 ms after it reads a 'stop' line (a well-behaved worker or recorder); false (default) ignores stop.
export function fakeChild({ pid = fakePid(), clock = null, kill = 'ignore', lateMs = 0, stopExits = false } = {}) {
  registerPid(pid); checkKillOptions(kill, clock, lateMs);
  const child = new EventEmitter(); let scheduled = null;
  const ended = () => child.exitCode !== null || child.signalCode !== null;
  const stdin = Object.assign(new EventEmitter(), {
    lines: [],
    write(line) {
      stdin.lines.push({ line: String(line), at: Date.now(), afterExit: ended() });
      if (stopExits && !ended() && String(line).trim() === 'stop') setTimeout(() => child.exit(0), 10);
      return true;
    },
  });
  Object.assign(child, {
    pid, stdin, stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null, killed: false, kills: [], kill_mode: kill,
    stoppedAt: () => stdin.lines.find(entry => entry.line.trim() === 'stop')?.at ?? null,
    kill(signal = 'SIGTERM') {
      child.kills.push({ signal, at: Date.now(), clockAt: clock?.now() ?? null });
      if (ended()) return false;
      if (kill === 'throw') throw oserror('EPERM', 'fake_process: kill refused');
      if (kill === 'refuse') return false;
      child.killed = true;
      if (kill === 'late' && !scheduled) scheduled = clock.after(lateMs, () => child.exit(null, 'SIGKILL'));
      return true;
    },
    // The child really ends: exitCode (or signalCode), then 'exit', then 'close' (stdio drained). Returns false when it had ended already.
    exit(code = 0, signal = null) {
      if (ended()) return false;
      if (scheduled) { clock.cancel(scheduled); scheduled = null; }
      if (signal) child.signalCode = signal; else child.exitCode = code;
      child.emit('exit', signal ? null : code, signal); child.emit('close', signal ? null : code, signal);
      return true;
    },
  });
  return child;
}

// Wires a fake recorder child to the runtime like spawnRecorder does (runtime.ts: rec.child/pid, and on 'exit' onRecorderGone), without
// spawning. Call it AFTER runtime.prepare(), which makes a new recorder record.
export function attachFakeRecorder(runtime, child) {
  const rec = runtime.recorder; rec.child = child; rec.pid = child.pid; rec.attached = false; rec.stopping = false; rec.state = 'RECORDING';
  let gone = false;
  child.on('exit', code => { if (gone) return; gone = true; runtime.onRecorderGone(child, code, ''); });
  return child;
}
// Wires a fake ASR worker child like spawnWorker does (runtime.capture, followMode, and on 'close' the `gone` handler: ignored while the
// worker is being stopped on purpose, else workerGone). Call it AFTER runtime.prepare().
export function attachFakeWorker(runtime, child, { follow = true, state = 'WARM_READY' } = {}) {
  const id = runtime.session.id;
  runtime.capture = child; runtime.followMode = follow; runtime.modelReady = true; runtime.captureId = 'fake-capture'; runtime.captureState = state;
  child.on('close', code => { if (runtime.capture !== child || runtime.workerStopping) return; runtime.capture = null; runtime.workerGone(id, follow, code, ''); });
  return child;
}

// Points runtime.alive / runtime.killPid at the fake PIDs. A PID that is not one of them is recorded in `stray` (the test asserts none):
// alive() answers true for it (fail closed), killPid() refuses.
export function installSeams(runtime, procs) {
  const byPid = new Map(procs.map(proc => [proc.pid, proc])); const stray = [];
  runtime.alive = pid => { const proc = byPid.get(pid); if (!proc) { stray.push({ call: 'alive', pid }); return true; } return proc.alive(pid); };
  runtime.killPid = pid => { const proc = byPid.get(pid); if (!proc) { stray.push({ call: 'killPid', pid }); throw oserror('EPERM', 'fake_process: not a fake PID'); } return proc.killPid(pid); };
  return { stray, add(proc) { byPid.set(proc.pid, proc); } };
}

// The fake PIDs are never used for an OS call: while this guard is on, process.kill with any fake PID is recorded as a violation and
// answers ESRCH (so nothing can reach a real process). Every other call goes to the real process.kill. restore() puts it back.
export function guardOsKill() {
  const real = process.kill; const violations = [];
  process.kill = function (pid, signal) {
    if (FAKE_PIDS.has(Math.abs(Number(pid)))) { violations.push({ pid, signal }); throw oserror('ESRCH', 'fake_process: a fake PID reached process.kill'); }
    return real.call(process, pid, signal);
  };
  return { violations, restore() { process.kill = real; } };
}
