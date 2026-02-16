import * as vscode from 'vscode';
import { Toolkit, SessionInfo } from '../toolkit';
import { SessionItem } from './sessionsProvider';

export class StarredProvider implements vscode.TreeDataProvider<SessionItem> {
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
        this.sessions = await this.toolkit.getStarredSessions();
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: SessionItem): vscode.TreeItem {
        return element;
    }

    getChildren(): SessionItem[] {
        if (this.sessions.length === 0) {
            return [];
        }

        return this.sessions.map(session => {
            const item = new SessionItem(session);
            item.iconPath = new vscode.ThemeIcon('star-full', new vscode.ThemeColor('list.warningForeground'));
            return item;
        });
    }
}
