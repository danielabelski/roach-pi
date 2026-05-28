# ROACH PI — Engineering Discipline for pi

ROACH PI is an extension suite for the pi coding agent that turns freeform coding sessions into a disciplined engineering loop. It's built around a simple conviction: **vague requests should not become vague code**.

The core workflow is **clarify → plan → implement → verify**. When you start a task, ROACH PI first forces ambiguity into the open with dynamic, context-aware questions (`/clarify`), then converts the clarified scope into an executable implementation plan (`/plan`), and runs the implementation through a **compliance → worker → validator** loop where building and verification stay separated.

## Extensions

Beyond the core loop, ROACH PI bundles seven extensions that make pi feel more like an IDE than a chat box:

- **Agentic Harness** — subagent orchestration (single, parallel, chain, async), multi-reviewer pipelines (`/ultrareview` dispatches 10 specialized reviewers in parallel), team mode, and structured progress tracking with live footer state.
- **FFF Search** — git-aware fuzzy file and content search with frecency ranking, replacing pi's default search. Powers both tools and `@` autocomplete.
- **LSP Code Intelligence** — IDE-grade operations inside pi: diagnostics, go-to-definition, find references, workspace-wide rename. Ships with 40+ language server configs.
- **Workspace Memory** — structured save/recall of findings, bug fixes, and decisions across sessions, so the agent stops rediscovering the same things.
- **Session Loop** — recurring prompts for health checks, monitoring, or continuous verification (`/loop 5m check git status`).
- **MCP Adapter** — token-efficient MCP integration via [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter). One proxy tool (~200 tokens) discovers and calls MCP tools on-demand. Servers are lazy by default. Supports OAuth, direct tool promotion, and interactive `/mcp` panel.
- **pi-code-previews** — syntax-highlighted previews for `bash`, `read`, `write`, `edit`, `grep`, `find`, and `ls` output in the pi TUI.

## Principles

Everything is plain TypeScript and Markdown in this repository. Commands, tools, hooks, agents, and skills are inspectable — no magic, no black boxes.

## Install

```bash
pi install git:github.com/tmdgusya/roach-pi
```

Then restart `pi` and run `/setup` once.
