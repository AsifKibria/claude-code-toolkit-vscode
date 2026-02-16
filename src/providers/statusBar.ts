import * as vscode from 'vscode';
import { Toolkit, HealthResult } from '../toolkit';

export class StatusBarManager implements vscode.Disposable {
    private statusBarItem: vscode.StatusBarItem;

    constructor(private toolkit: Toolkit) {
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );

        const config = vscode.workspace.getConfiguration('claudeToolkit');
        if (config.get('showStatusBar')) {
            this.statusBarItem.show();
        }

        this.statusBarItem.command = 'claudeToolkit.healthCheck';
        this.statusBarItem.text = '$(sync~spin) Claude';
        this.statusBarItem.tooltip = 'Claude Toolkit - Checking...';
    }

    update(health: HealthResult): void {
        if (health.healthy) {
            this.statusBarItem.text = '$(check) Claude';
            this.statusBarItem.tooltip = `Claude Toolkit - Healthy\n${health.sessionCount} sessions`;
            this.statusBarItem.backgroundColor = undefined;
        } else {
            this.statusBarItem.text = `$(warning) Claude (${health.issues})`;
            this.statusBarItem.tooltip = `Claude Toolkit - ${health.issues} issue(s)\nClick to view details`;
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        }
    }

    async checkHealth(): Promise<void> {
        const health = await this.toolkit.healthCheck();
        this.update(health);
    }

    dispose(): void {
        this.statusBarItem.dispose();
    }
}
