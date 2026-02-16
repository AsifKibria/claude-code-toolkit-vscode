import * as vscode from 'vscode';
import { HealthProvider } from './providers/healthProvider';
import { SessionsProvider } from './providers/sessionsProvider';
import { StarredProvider } from './providers/starredProvider';
import { MaintenanceProvider } from './providers/maintenanceProvider';
import { StatusBarManager } from './providers/statusBar';
import { Toolkit } from './toolkit';

let statusBar: StatusBarManager;
let refreshInterval: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext) {
    const toolkit = new Toolkit();

    const healthProvider = new HealthProvider(toolkit);
    const sessionsProvider = new SessionsProvider(toolkit);
    const starredProvider = new StarredProvider(toolkit);
    const maintenanceProvider = new MaintenanceProvider(toolkit);

    vscode.window.registerTreeDataProvider('claudeToolkit.health', healthProvider);
    vscode.window.registerTreeDataProvider('claudeToolkit.sessions', sessionsProvider);
    vscode.window.registerTreeDataProvider('claudeToolkit.starred', starredProvider);
    vscode.window.registerTreeDataProvider('claudeToolkit.maintenance', maintenanceProvider);

    statusBar = new StatusBarManager(toolkit);
    context.subscriptions.push(statusBar);

    context.subscriptions.push(
        vscode.commands.registerCommand('claudeToolkit.showDashboard', async () => {
            const result = await toolkit.startDashboard();
            if (result.success && result.url) {
                vscode.env.openExternal(vscode.Uri.parse(result.url));
            } else {
                vscode.window.showErrorMessage('Failed to start dashboard');
            }
        }),

        vscode.commands.registerCommand('claudeToolkit.healthCheck', async () => {
            const health = await toolkit.healthCheck();
            healthProvider.refresh();
            statusBar.update(health);

            if (health.issues > 0) {
                vscode.window.showWarningMessage(
                    `Claude Toolkit: ${health.issues} issue(s) found`,
                    'View Details'
                ).then(selection => {
                    if (selection === 'View Details') {
                        vscode.commands.executeCommand('claudeToolkit.showDashboard');
                    }
                });
            } else {
                vscode.window.showInformationMessage('Claude Toolkit: All systems healthy');
            }
        }),

        vscode.commands.registerCommand('claudeToolkit.searchSessions', async () => {
            const query = await vscode.window.showInputBox({
                prompt: 'Search conversations',
                placeHolder: 'Enter search query...'
            });

            if (query) {
                const results = await toolkit.searchConversations(query);
                if (results.length === 0) {
                    vscode.window.showInformationMessage('No matching conversations found');
                    return;
                }

                const items = results.map(r => ({
                    label: r.preview,
                    description: `${r.project} - ${r.role}`,
                    detail: r.file,
                    sessionId: r.sessionId
                }));

                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: `${results.length} results found`
                });

                if (selected) {
                    vscode.commands.executeCommand('claudeToolkit.openSession', selected.sessionId);
                }
            }
        }),

        vscode.commands.registerCommand('claudeToolkit.refreshSessions', () => {
            sessionsProvider.refresh();
            starredProvider.refresh();
        }),

        vscode.commands.registerCommand('claudeToolkit.starSession', async (item) => {
            if (item?.sessionId) {
                await toolkit.starSession(item.sessionId);
                sessionsProvider.refresh();
                starredProvider.refresh();
                vscode.window.showInformationMessage('Session starred');
            }
        }),

        vscode.commands.registerCommand('claudeToolkit.unstarSession', async (item) => {
            if (item?.sessionId) {
                await toolkit.unstarSession(item.sessionId);
                sessionsProvider.refresh();
                starredProvider.refresh();
                vscode.window.showInformationMessage('Session unstarred');
            }
        }),

        vscode.commands.registerCommand('claudeToolkit.exportSession', async (item) => {
            if (item?.sessionId) {
                const format = await vscode.window.showQuickPick(
                    ['HTML', 'Markdown', 'JSON'],
                    { placeHolder: 'Select export format' }
                );

                if (format) {
                    const uri = await vscode.window.showSaveDialog({
                        defaultUri: vscode.Uri.file(`session-${item.sessionId.slice(0, 8)}.${format.toLowerCase()}`),
                        filters: { [format]: [format.toLowerCase()] }
                    });

                    if (uri) {
                        const result = await toolkit.exportSession(item.sessionId, format.toLowerCase(), uri.fsPath);
                        if (result.success) {
                            vscode.window.showInformationMessage('Session exported successfully');
                            vscode.commands.executeCommand('vscode.open', uri);
                        } else {
                            vscode.window.showErrorMessage(`Export failed: ${result.error}`);
                        }
                    }
                }
            }
        }),

        vscode.commands.registerCommand('claudeToolkit.archiveSession', async (item) => {
            if (item?.sessionId) {
                const confirm = await vscode.window.showWarningMessage(
                    'Archive this session?',
                    { modal: true },
                    'Archive'
                );

                if (confirm === 'Archive') {
                    await toolkit.archiveSession(item.sessionId);
                    sessionsProvider.refresh();
                    starredProvider.refresh();
                    vscode.window.showInformationMessage('Session archived');
                }
            }
        }),

        vscode.commands.registerCommand('claudeToolkit.deleteSession', async (item) => {
            if (item?.sessionId) {
                const confirm = await vscode.window.showWarningMessage(
                    'Delete this session? This cannot be undone.',
                    { modal: true },
                    'Delete'
                );

                if (confirm === 'Delete') {
                    await toolkit.deleteSession(item.sessionId);
                    sessionsProvider.refresh();
                    vscode.window.showInformationMessage('Session deleted');
                }
            }
        }),

        vscode.commands.registerCommand('claudeToolkit.runMaintenance', async () => {
            const result = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Running maintenance...',
                cancellable: false
            }, async () => {
                return await toolkit.runMaintenance();
            });

            maintenanceProvider.refresh();
            vscode.window.showInformationMessage(
                `Maintenance complete: ${result.cleaned} items cleaned, ${result.freedBytes} freed`
            );
        }),

        vscode.commands.registerCommand('claudeToolkit.securityScan', async () => {
            const result = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Running security scan...',
                cancellable: false
            }, async () => {
                return await toolkit.securityScan();
            });

            if (result.issues > 0) {
                vscode.window.showWarningMessage(
                    `Security scan found ${result.issues} potential issue(s)`,
                    'View Details'
                ).then(selection => {
                    if (selection === 'View Details') {
                        vscode.commands.executeCommand('claudeToolkit.showDashboard');
                    }
                });
            } else {
                vscode.window.showInformationMessage('Security scan: No issues found');
            }
        }),

        vscode.commands.registerCommand('claudeToolkit.openSession', async (sessionId: string) => {
            const session = await toolkit.getSession(sessionId);
            if (session?.filePath) {
                const doc = await vscode.workspace.openTextDocument(session.filePath);
                await vscode.window.showTextDocument(doc);
            }
        })
    );

    const config = vscode.workspace.getConfiguration('claudeToolkit');
    if (config.get('autoRefresh')) {
        const interval = (config.get('refreshInterval') as number || 60) * 1000;
        refreshInterval = setInterval(() => {
            healthProvider.refresh();
            sessionsProvider.refresh();
            statusBar.checkHealth();
        }, interval);
    }

    toolkit.healthCheck().then(health => {
        statusBar.update(health);

        if (config.get('showNotifications') && health.issues > 0) {
            vscode.window.showWarningMessage(
                `Claude Toolkit: ${health.issues} issue(s) detected`,
                'View'
            ).then(selection => {
                if (selection === 'View') {
                    vscode.commands.executeCommand('claudeToolkit.showDashboard');
                }
            });
        }
    });
}

export function deactivate() {
    if (refreshInterval) {
        clearInterval(refreshInterval);
    }
}
