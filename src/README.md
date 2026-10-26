# Implementation workspace

Runtime 0.2.0 implements local MCP/session/source/text-store controls in TypeScript/Node, a Python WASAPI/local-ASR worker and browser panel. Dependencies and public ASR model are pinned. Actual Claude Desktop tool execution and device capture are pending owner action; see docs/PILOT_RUNTIME_20261026.md.

The AI agent owns the workflow. Planned responsibilities here: session/resource control, source/hearing tools, context tools, caption publication/text storage, local display and host integration. Start with the synthetic tool slice in docs/ROADMAP.md and prove the real Claude Desktop loop before expanding capture. Implement independently; do not link or copy the AIOS interpreter source tree.
