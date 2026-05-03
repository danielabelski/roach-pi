# Lessons

- Before making or committing changes, confirm the target repository path when multiple repos are in context. Do not continue working in a repo just because it appeared in compacted history; explicitly verify it matches the user's current "our repo" reference.
- For UI state that survives reload, always test both live event handling and `session_start` history reconstruction. A fix that only handles new tool events can still fail after reload if stale custom snapshots are restored.
- For milestone tracking, test every real lifecycle signal separately: artifact/state discovery, active planning start, execution, validation, completion, and reload. Do not assume detecting the milestone list implies active status transitions work.
- Before patching UI state tracking based on a live screenshot, verify whether the visible state is actually expected for the current workflow phase. Do not treat “not visibly active yet” as a bug until the lifecycle source of truth (state.md/session event/current phase) confirms it.
