import * as vscode from 'vscode';
import { Toolkit, HealthResult } from '../toolkit';

export class HealthProvider implements vscode.TreeDataProvider<HealthItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<HealthItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private health: HealthResult | null = null;

    constructor(private toolkit: Toolkit) {
        this.loadHealth();
    }

    refresh(): void {
        this.loadHealth();
    }

    private async loadHealth(): Promise<void> {
        this.health = await this.toolkit.healthCheck();
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: HealthItem): vscode.TreeItem {
        return element;
    }

    getChildren(): HealthItem[] {
        if (!this.health) {
            return [new HealthItem('Loading...', '', vscode.TreeItemCollapsibleState.None)];
        }

        const items: HealthItem[] = [];

        const statusIcon = this.health.healthy ? '$(check)' : '$(warning)';
        const statusLabel = this.health.healthy ? 'Healthy' : `${this.health.issues} Issue(s)`;
        items.push(new HealthItem(`${statusIcon} Status: ${statusLabel}`, 'status', vscode.TreeItemCollapsibleState.None));

        items.push(new HealthItem(`$(archive) Sessions: ${this.health.sessionCount}`, 'sessions', vscode.TreeItemCollapsibleState.None));

        const timeStr = this.health.lastCheck.toLocaleTimeString();
        items.push(new HealthItem(`$(clock) Last Check: ${timeStr}`, 'time', vscode.TreeItemCollapsibleState.None));

        if (this.health.warnings.length > 0) {
            const warningsItem = new HealthItem(
                `$(alert) Warnings (${this.health.warnings.length})`,
                'warnings',
                vscode.TreeItemCollapsibleState.Expanded
            );
            warningsItem.children = this.health.warnings.map(w =>
                new HealthItem(w, 'warning', vscode.TreeItemCollapsibleState.None)
            );
            items.push(warningsItem);
        }

        return items;
    }
}

class HealthItem extends vscode.TreeItem {
    children?: HealthItem[];

    constructor(
        public readonly label: string,
        public readonly type: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(label, collapsibleState);

        if (type === 'warning') {
            this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
        }
    }
}
