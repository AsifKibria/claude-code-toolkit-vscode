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
        this.description = session.modified || formatSize(session.sizeBytes);
        this.tooltip = `Session: ${session.id}\nProject: ${session.project}\nModified: ${session.modified}`;
        this.contextValue = session.starred ? 'starredSession' : 'session';

        if (session.starred) {
            this.iconPath = new vscode.ThemeIcon('star-full', new vscode.ThemeColor('list.warningForeground'));
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
    if (bytes === 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
