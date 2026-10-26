# Claude entry point

Read `AGENTS.md`, `README.md`, `docs/PRODUCT_BASELINE.md`, `docs/DECISION_LOG.md`, then `project.json`.
Those files define this independent personal project and the current scope.

The AI agent owns the meeting-assistance workflow and invokes the toolkit. Claude Desktop is the first required host; AGY and Codex are later alternatives. V1 supports an already-open meeting with a live translation panel; Q&A comes later. Save text history locally; audio is temporary.

Local tools and an audio worker are implemented, but actual host calls/device capture/continuous agent behavior are not verified. The current afternoon pilot is Vietnamese only and does not translate; read docs/PILOT_RUNTIME_20261026.md. Meeting prompts are user-run examples, not instructions to start recording during development.
