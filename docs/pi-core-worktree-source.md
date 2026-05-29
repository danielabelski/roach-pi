# Pi Core Source and Build/Test Workflow

This document captures the editable pi core checkout prepared for the worktree-session goal.

## Editable core checkout

- Source path: `/Users/lit/.pi/agent/git/github.com/earendil-works/pi`
- Remote: `https://github.com/earendil-works/pi.git`
- Current HEAD: `7be8a10d`
- Core package: `/Users/lit/.pi/agent/git/github.com/earendil-works/pi/packages/coding-agent`
- Package name/version: `@earendil-works/pi-coding-agent@0.77.0`
- Installed/global pi package checked for parity: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`, version `0.77.0`
- Working tree after preparation: clean

This is the durable editable source for core work. Do not implement core behavior by patching `node_modules` in this roach-pi extension checkout.

## Relevant core files for later subgoals

- CLI entry and argument parsing:
  - `packages/coding-agent/src/cli.ts`
  - `packages/coding-agent/src/cli/args.ts`
  - `packages/coding-agent/src/main.ts`
- Session/runtime replacement:
  - `packages/coding-agent/src/core/session-manager.ts`
  - `packages/coding-agent/src/core/agent-session-runtime.ts`
- Interactive commands and shutdown paths:
  - `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
  - `packages/coding-agent/src/core/slash-commands.ts`

## Preparation commands run

```bash
mkdir -p /Users/lit/.pi/agent/git/github.com/earendil-works
git clone https://github.com/earendil-works/pi.git /Users/lit/.pi/agent/git/github.com/earendil-works/pi
cd /Users/lit/.pi/agent/git/github.com/earendil-works/pi
npm install
npm run build
```

`npm run build` passed after installing workspace dependencies. The build generated model metadata during `packages/ai` build; those generated-file changes were reset afterward so the checkout remained clean.

## Confirmed test workflow

Run the monorepo build before the coding-agent test suite so workspace package `dist/` entries exist:

```bash
cd /Users/lit/.pi/agent/git/github.com/earendil-works/pi
npm run build
npm --prefix packages/coding-agent test
```

Observed test status after build:

- Full `npm --prefix packages/coding-agent test`: 126 files passed, 6 skipped, 1 test failed.
- The single observed failure was `test/session-id-readonly.test.ts > rejects an existing fork target session id`, where stderr contained an upstream/provider `401 authentication_error` instead of the expected duplicate session-id message.
- Focused tests relevant to upcoming worktree implementation passed:

```bash
npm --prefix packages/coding-agent exec vitest --run \
  test/args.test.ts \
  test/session-manager/file-operations.test.ts \
  test/suite/agent-session-runtime.test.ts
```

Focused result: 3 files passed, 91 tests passed.

## Notes for implementation

- `packages/coding-agent/package.json` exposes `build` and `test` scripts.
- The root build order is important: `packages/tui`, `packages/ai`, `packages/agent`, then `packages/coding-agent`.
- The global installed pi package and editable checkout both report `@earendil-works/pi-coding-agent@0.77.0`, so the checkout matches the active installed package version.
