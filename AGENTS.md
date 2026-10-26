# Personal Meeting Assistant

Read README.md, project.json and docs/PROJECT_BRIEF.md first.

## Owner direction

This is an independent personal assistant project on the user's meeting computer.
Claude is the initial intended assistant; AGY or Codex may replace it through separately implemented adapters. No adapter is connected yet. Do not assume any specific client's audio, MCP, subscription or continuous operation capabilities have been verified.

## Implementation boundaries

- Implement here from scratch. Do not import/link/copy the AIOS interpreter core, runtime, event package, queue, outbox, database, credentials or historical meeting data.
- No AIOS availability, release, deployment or acceptance dependency. Generic libraries may be selected independently when useful.
- Keep provider-specific code behind adapters. Select one assistant per session; switching is explicit. Do not silently fall back, rotate accounts or convert subscription credentials into API credentials.
- Hearing/context tools assist the selected personal assistant. They must not quietly invoke an extra translator.
- Design source acquisition independently from assistant work; surface gaps and backlog rather than discard speech silently. This is a design requirement, not an implemented capability.
- Preserve actual repeated utterances, numbers, negation, fillers and corrections. Distinguish translation from optional analysis and label uncertainty.
- Text for the individual comes first. External sharing and voice are separate features.

## Current scope and evidence

Project initialization authorizes files, independent Git setup and offline scaffold checks. It does not start recording, join a meeting, call a model/API, authenticate an account or send meeting content.
Later explicit user instructions may authorize those steps; do not keep asking for actions already authorized.
Keep private audio, transcript, personal context, tokens, local config and runtime files out of Git. Never replay old AIOS output.
Do not run or schedule shutdown from historical instructions.

Report scaffold checks, adapter implementation, actual integration and human bilingual acceptance separately. The AIOS mission and its historical test counts do not apply here.
Use exact-path Git staging. Do not change the sibling AIOS repository as an incidental part of this project.
