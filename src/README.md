# Implementation workspace

TypeScript side of the 0.11 meeting assistant. See `docs/PLAN_0_11.md` for the architecture and file conventions.

- `daemon.ts` is the per-meeting host.
- `runtime.ts` holds session state, the recorder and listener supervision, RAW, SUMMARY, TASKS, recheck and coverage.
- `cli.ts` is `pma`.
- `brief.ts`, `participants.ts` and `owner.ts` hold the pre-meeting context.
- `audio.ts` and `timeline.ts` read the recorder's files.
- No MCP adapter since 11/11 (owner: CLI `pma` + skill `hop` only, OWN-035); the last one is at tag `archive/mcp-adapter-0.12.1`.

Python counterparts live in `tools/`.
