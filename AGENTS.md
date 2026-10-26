# Personal Meeting Assistant

Read README.md, docs/PRODUCT_BASELINE.md, docs/DECISION_LOG.md and project.json first. Verify the document snapshot with `python tools/verify_baseline.py` before changing locked documents.

## Owner direction

This is an independent personal assistant project on the user's meeting computer.
Claude Desktop is the first required host. The product is a toolkit around the personal AI agent: the agent selects and invokes tools to support an already-open meeting. AGY or Codex may replace the host later. The local runtime is implemented. Claude overwrote the initial external MCP config edit while running; the guarded installer must run after the owner fully quits Claude. Actual host calls remain unverified.

Owner-locked V1: the agent activates hearing, obtains context and publishes a live personal translation panel; interactive Q&A comes later. Text history is saved locally by default; audio is temporary. See OWN-001 through OWN-008; OWN-008 is the current Vietnamese-only pilot. Do not turn this into an app-driven translation pipeline or claim Desktop's continuous agent loop is already proven.

## Implementation boundaries

- Implement here from scratch. Do not import/link/copy the AIOS interpreter core, runtime, event package, queue, outbox, database, credentials or historical meeting data.
- No AIOS availability, release, deployment or acceptance dependency. Generic libraries may be selected independently when useful.
- Keep host-specific integration behind adapters; expose the same domain tools where supported. Select one assistant per session; switching is explicit. Do not silently fall back, rotate accounts or convert subscription credentials into API credentials.
- Hearing/context tools assist the selected personal assistant. They must not quietly invoke an extra translator.
- Design source acquisition independently from assistant work; surface gaps and backlog rather than discard speech silently. This is a design requirement, not an implemented capability.
- Preserve actual repeated utterances, numbers, negation, fillers and corrections. Distinguish translation from optional analysis and label uncertainty.
- Text for the individual comes first. Q&A, external sharing, voice and automatic meeting Join are outside V1.
- Agent planning does not replace tool-side resource control. A user-authorized session can cover routine hearing/context/caption actions without confirmation per chunk. STOP, scope validation, storage bounds and cleanup are enforced by tools independently of model availability.

## Current scope and evidence

Current owner scope (26 October): build/install a minimal runtime for this afternoon, Vietnamese only, no translation. Source preference is G243FW. The owner chose to restart Claude themselves later; do not restart Claude or run the offered device-capture test on their behalf. Local coding, dependency/model setup, public-file ASR and offline/protocol/UI tests are authorized. Read docs/PILOT_RUNTIME_20261026.md before operating this pilot.
Later explicit user instructions may authorize those steps; do not keep asking for actions already authorized.
Keep private audio, transcript, personal context, tokens, local config and runtime files out of Git. Never replay old AIOS output.
Do not run or schedule shutdown from historical instructions.

Report scaffold checks, adapter implementation, actual integration and human bilingual acceptance separately. The AIOS mission and its historical test counts do not apply here.
Use exact-path Git staging. Do not change the sibling AIOS repository as an incidental part of this project.

Follow docs/CHANGE_CONTROL.md. OWNER_LOCKED decisions require a new owner instruction to change. ENGINEERING_BASELINE decisions may evolve with evidence and a recorded revision; they are not all owner approvals. A valid document hash is not product acceptance.
