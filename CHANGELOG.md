# Changelog

All notable changes to the **Claude Code Toolkit** VS Code extension.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.0.0] — 2026-05

### Added

- **Right-click → Fix Oversized Content** — scrub a single session (or all sessions) with one click. Backups are automatic.
- **Right-click → Unstick Session** — dedicated rescue for sessions stuck on `PDF too large` / `Image too large` errors (issue [#13518](https://github.com/anthropics/claude-code/issues/13518)). Scrubs oversized base64 *and* clears the per-session warning state files Claude Code uses to remember the bad state.
- **Configurable prompt-handoff target** — new `claudeToolkit.defaultSendTarget` setting (`ask` / `chat` / `terminal`) controls where queued prompts go.
- **Branded icon** — Claude-orange squircle, edge-to-edge rendered (no white margins), with a monochrome sidebar variant that picks up the active VS Code theme color.

### Fixed

- **Multi-line prompts no longer mangle into literal `\n` characters** — the queue → terminal handoff was escaping newlines wrong. Prompts now go through a temp file piped via `cat … | claude` (POSIX) or `Get-Content -Raw … | claude` (Windows), preserving every byte.
- **"Send to Chat" actually focuses Claude Code's chat panel** — the queue picker now copies the prompt to the clipboard and invokes `claude-vscode.sidebar.open` + `claude-vscode.focus`. The old behaviour shoved a one-shot CLI command into a new terminal that didn't reuse the live session.
- **Cap auto-detection scans the right directory** — was watching the always-empty `~/.claude/logs/`; now watches `~/.claude/projects/*.jsonl` recursively and reads only the tail (last 20 KB) of the 3 most-recent sessions.
- **Stale install** — replaces the never-repackaged 1.3.3 build that lagged the source by months.

### Changed

- README cut to a single screen with TL;DR-first content.
- Tests updated to match the new chat/terminal handoff contract; 18/18 passing.

## [1.3.x] and earlier

See git history.
