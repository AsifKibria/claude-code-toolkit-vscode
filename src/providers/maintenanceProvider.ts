import * as vscode from 'vscode';
import { Toolkit } from '../toolkit';

export class MaintenanceProvider implements vscode.TreeDataProvider<MaintenanceItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<MaintenanceItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private toolkit: Toolkit) {}

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: MaintenanceItem): vscode.TreeItem {
        return element;
    }

    getChildren(): MaintenanceItem[] {
        return [
            new MaintenanceItem('Run Maintenance', 'maintenance', 'claudeToolkit.runMaintenance', 'tools'),
            new MaintenanceItem('Security Scan', 'security', 'claudeToolkit.securityScan', 'shield'),
            new MaintenanceItem('Open Dashboard', 'dashboard', 'claudeToolkit.showDashboard', 'dashboard'),
            new MaintenanceItem('Health Check', 'health', 'claudeToolkit.healthCheck', 'heart')
        ];
    }
}

class MaintenanceItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly type: string,
        commandId: string,
        icon: string
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(icon);
        this.command = {
            command: commandId,
            title: label
        };
    }
}
