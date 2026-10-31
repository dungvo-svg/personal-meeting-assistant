// Manual microphone state for the owner's channel ("Tôi"). The recorder writes `mic_state` lines into the session's
// timeline.jsonl from tools/mic_state.ps1; when that reader cannot tell (an app it does not know, a Meet tab in the
// background) the owner says it with `pma me --on | --off`, and `--auto` hands it back to the reader. The entry goes
// into the same timeline (<dataDir>/audio/<sessionId>/timeline.jsonl, plan 0.11 Q-1) with by:"manual"; tools/mic_state.py
// lets the latest manual on/off win over automatic readings until a manual release.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { audioDir } from './audio.js';
import type { MeetingRuntime } from './runtime.js';

export type MicChoice = 'on' | 'off' | 'auto';

export function setMicState(runtime: MeetingRuntime, choice: MicChoice, now = new Date()) {
  if (!['on', 'off', 'auto'].includes(choice)) throw new Error('INVALID_MIC_STATE: on, off hoặc auto');
  runtime.requireSession(runtime.session?.id);
  const dir = audioDir(runtime.dataDir, runtime.session.id); mkdirSync(dir, { recursive: true });
  const entry = choice === 'auto'
    ? { t: now.toISOString(), type: 'mic_state', state: 'unknown', app: 'none', by: 'manual', release: true }
    : { t: now.toISOString(), type: 'mic_state', state: choice, app: 'none', by: 'manual' };
  const path = join(dir, 'timeline.jsonl');
  appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
  return { path, entry };
}
