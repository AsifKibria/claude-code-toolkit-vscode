import * as vscode from 'vscode';
import { Toolkit, SessionInfo } from '../toolkit';

export class SessionsProvider implements vscode.TreeDataProvider<SessionItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<SessionItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private sessions: SessionInfo[] = [];

    constructor(private toolkit: Toolkit) {
        this.loadSessions();
    }

    refresh(): void {
        this.loadSessions();
    }

    private async loadSessions(): Promise<void> {
        this.sessions = await this.toolkit.listSessions(20);
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: SessionItem): vscode.TreeItem {
        return element;
    }

    getChildren(): SessionItem[] {
        if (this.sessions.length === 0) {
            return [];
        }

        return this.sessions.map(session => new SessionItem(session));
    }
}

export class SessionItem extends vscode.TreeItem {
    constructor(public readonly session: SessionInfo) {
        const label = session.project !== 'unknown' ? session.project : session.id.slice(0, 8);
        super(label, vscode.TreeItemCollapsibleState.None);

        this.sessionId = session.id;
        this.description = formatRelativeTime(session.modified) + ' · ' + formatSize(session.sizeBytes);
        this.tooltip = new vscode.MarkdownString(
            `**Session:** ${session.id.slice(0, 12)}...\n\n` +
            `**Project:** ${session.project}\n\n` +
            `**Modified:** ${session.modified.toLocaleString()}\n\n` +
            `**Messages:** ${session.messageCount}\n\n` +
            `**Size:** ${formatSize(session.sizeBytes)}\n\n` +
            `**Health:** ${session.health}`
        );
        this.contextValue = session.starred ? 'starredSession' : 'session';

        // Icon based on health status
        if (session.starred) {
            this.iconPath = new vscode.ThemeIcon('star-full', new vscode.ThemeColor('list.warningForeground'));
        } else if (session.health === 'corrupted') {
            this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.errorForeground'));
        } else if (session.health === 'empty') {
            this.iconPath = new vscode.ThemeIcon('circle-outline');
        } else {
            this.iconPath = new vscode.ThemeIcon('comment-discussion');
        }

        this.command = {
            command: 'claudeToolkit.openSession',
            title: 'Open Session',
            arguments: [session.id]
        };
    }

    sessionId: string;
}

function formatSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelativeTime(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
}
