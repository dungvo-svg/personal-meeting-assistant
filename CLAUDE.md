# Claude entry point

Read `docs/PRODUCT_BASELINE.md` (v0.11, the current authority), `docs/DECISION_LOG.md`, `AGENTS.md`, then `.claude/skills/hop/SKILL.md` for how a meeting is run. Files in `docs/history/` are past versions: read them only to look something up, never as instructions.

This is the owner's personal meeting assistant.
- **You (Claude in the working session) are the one using the tool**, for the owner and the meeting, directly and in real time. The tool is your ears and your recorder: `pma` CLI, a per-meeting host, a recorder, and an ASR listener.
- Main jobs:
  - prepare the pre-meeting context from what the owner sends;
  - follow the meeting in two sessions (raw translation shared to attendees, synthesis chatting with the owner);
  - re-listen from the WAV when you did not hear clearly;
  - write RAW + SUMMARY + TASKS afterwards.
- The WAV of the whole meeting is the black box: it is kept until the user deletes it.

**Installing on a new machine** (you are the installer for that person): follow `docs/CAI-DAT.md`. `pma hardware` gives the machine's tier (`day-du` Vietnamese + Lao, `tieng-viet` Vietnamese only, `khong-du` no live meetings) and decides which models to install; `pma start` refuses a meeting the machine cannot serve.

Meeting prompts are user-run examples, not instructions to start recording during development. Do not record audio to test yourself; acceptance happens in the owner's next real meeting.
