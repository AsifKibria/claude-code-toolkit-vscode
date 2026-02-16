# Claude Code Toolkit for VS Code

Health monitoring, session management, and maintenance tools for Claude Code - directly in VS Code.

## Features

### Status Bar Health Indicator
- Real-time health status in the VS Code status bar
- Click to run a health check
- Visual warnings when issues are detected

### Session Management
- Browse recent Claude Code sessions
- Star/bookmark important sessions
- Search across all conversations
- Export sessions to HTML, Markdown, or JSON
- Archive or delete old sessions

### Maintenance Tools
- One-click maintenance operations
- Security scanning for leaked secrets
- Open the full web dashboard

### Command Palette
All features accessible via Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`):
- `Claude Toolkit: Health Check`
- `Claude Toolkit: Search Conversations`
- `Claude Toolkit: Open Dashboard`
- `Claude Toolkit: Run Maintenance`
- `Claude Toolkit: Security Scan`

## Requirements

- [Claude Code](https://claude.ai/code) installed
- Node.js 18+
- The Claude Code Toolkit npm package will be installed automatically

## Installation

1. Install from VS Code Marketplace
2. The extension activates automatically when VS Code starts
3. Look for the Claude Toolkit icon in the Activity Bar

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeToolkit.showStatusBar` | `true` | Show health indicator in status bar |
| `claudeToolkit.autoRefresh` | `true` | Auto-refresh session list |
| `claudeToolkit.refreshInterval` | `60` | Refresh interval in seconds |
| `claudeToolkit.showNotifications` | `true` | Show notifications for issues |

## Sidebar Views

### Health
Shows current health status, session count, and any warnings or issues.

### Starred Sessions
Quick access to your bookmarked/starred sessions.

### Recent Sessions
Browse your most recent Claude Code conversations. Right-click for actions:
- Star/Unstar
- Export (HTML/Markdown/JSON)
- Archive
- Delete

### Maintenance
Quick actions for maintenance tasks:
- Run Maintenance
- Security Scan
- Open Dashboard
- Health Check

## License

MIT

## Links

- [Claude Code Toolkit on npm](https://www.npmjs.com/package/@asifkibria/claude-code-toolkit)
- [GitHub Repository](https://github.com/asifkibria/claude-code-toolkit-vscode)
- [Report Issues](https://github.com/asifkibria/claude-code-toolkit-vscode/issues)
