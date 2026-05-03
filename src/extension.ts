import * as vscode from 'vscode';
import { HealthProvider } from './providers/healthProvider';
import { SessionsProvider } from './providers/sessionsProvider';
import { StarredProvider } from './providers/starredProvider';
import { MaintenanceProvider } from './providers/maintenanceProvider';
import { StatusBarManager } from './providers/statusBar';
import { UsageCapProvider } from './providers/usageCapProvider';
import { Toolkit } from './toolkit';

let statusBar: StatusBarManager;
let usageCapProvider: UsageCapProvider;
let refreshInterval: NodeJS.Timeout | undefined;
let output: vscode.OutputChannel;

const DISMISS_KEY = 'claudeToolkit.dismissStartupNotice';

export function activate(context: vscode.ExtensionContext) {
    output = vscode.window.createOutputChannel('Claude Toolkit');
    context.subscriptions.push(output);

    const toolkit = new Toolkit();
    toolkit.setLogger((msg) => output.appendLine(`[${new Date().toISOString()}] ${msg}`));

    const healthProvider = new HealthProvider(toolkit);
    const sessionsProvider = new SessionsProvider(toolkit);
    const starredProvider = new StarredProvider(toolkit);
    const maintenanceProvider = new MaintenanceProvider(toolkit);

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('claudeToolkit.health', healthProvider),
        vscode.window.registerTreeDataProvider('claudeToolkit.sessions', sessionsProvider),
        vscode.window.registerTreeDataProvider('claudeToolkit.starred', starredProvider),
        vscode.window.registerTreeDataProvider('claudeToolkit.maintenance', maintenanceProvider)
    );

    usageCapProvider = new UsageCapProvider();
    vscode.window.registerTreeDataProvider('claudeToolkit.usageCap', usageCapProvider);
    context.subscriptions.push(usageCapProvider);

    statusBar = new StatusBarManager(toolkit);
    context.subscriptions.push(statusBar);

    context.subscriptions.push(
        vscode.commands.registerCommand('claudeToolkit.showDashboard', async () => {
            await openDashboard(toolkit);
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
        }),

        vscode.commands.registerCommand('claudeToolkit.addCapTask', () => {
            usageCapProvider.addPrompt();
        }),

        vscode.commands.registerCommand('claudeToolkit.addQuickPrompt', () => {
            usageCapProvider.addQuickPrompt();
        }),

        vscode.commands.registerCommand('claudeToolkit.sendPrompt', (promptId: string) => {
            usageCapProvider.sendPrompt(promptId);
        }),

        vscode.commands.registerCommand('claudeToolkit.editPrompt', (item) => {
            if (item?.promptId) {
                usageCapProvider.editPrompt(item.promptId);
            }
        }),

        vscode.commands.registerCommand('claudeToolkit.removePrompt', (item) => {
            if (item?.promptId) {
                usageCapProvider.removePrompt(item.promptId);
            }
        }),

        vscode.commands.registerCommand('claudeToolkit.simulateCapReached', () => {
            usageCapProvider.simulateCapReached();
        }),

        vscode.commands.registerCommand('claudeToolkit.setCapResetTime', () => {
            usageCapProvider.setCapWithResetTime();
        }),

        vscode.commands.registerCommand('claudeToolkit.clearCapStatus', () => {
            usageCapProvider.clearCapStatus();
        }),

        vscode.commands.registerCommand('claudeToolkit.clearSentPrompts', () => {
            usageCapProvider.clearSent();
        }),

        vscode.commands.registerCommand('claudeToolkit.refreshUsageCap', () => {
            usageCapProvider.refresh();
        }),

        vscode.commands.registerCommand('claudeToolkit.fixSession', async (item) => {
            const sessionId = item?.sessionId as string | undefined;
            const result = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: sessionId ? `Fixing session ${sessionId.slice(0, 8)}…` : 'Scrubbing oversized content from all sessions…',
                cancellable: false
            }, () => toolkit.fixSession(sessionId));

            healthProvider.refresh();
            sessionsProvider.refresh();
            statusBar.checkHealth();

            const errorSummary = result.errors.length > 0 ? ` (${result.errors.length} error${result.errors.length === 1 ? '' : 's'})` : '';
            if (result.fixed === 0) {
                vscode.window.showInformationMessage(`No oversized content found across ${result.scanned} session${result.scanned === 1 ? '' : 's'}.${errorSummary}`);
            } else {
                vscode.window.showInformationMessage(`Fixed ${result.fixed} session${result.fixed === 1 ? '' : 's'} (scanned ${result.scanned}).${errorSummary}`);
            }
        }),

        vscode.commands.registerCommand('claudeToolkit.unstickSession', async (item) => {
            const sessionId = item?.sessionId as string | undefined;
            if (!sessionId) {
                vscode.window.showWarningMessage('Pick a session from the sidebar to unstick.');
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                'Unstick this session? This scrubs oversized content and clears any per-session error state. A backup is created.',
                { modal: true },
                'Unstick'
            );
            if (confirm !== 'Unstick') return;

            const result = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Unsticking ${sessionId.slice(0, 8)}…`,
                cancellable: false
            }, () => toolkit.unstickSession(sessionId));

            sessionsProvider.refresh();
            healthProvider.refresh();

            if (!result.ok) {
                vscode.window.showErrorMessage(`Could not unstick session: ${result.reason ?? 'unknown error'}`);
                return;
            }

            const summary = result.scrubbed > 0
                ? `Scrubbed ${result.scrubbed} oversized item${result.scrubbed === 1 ? '' : 's'}. Reload the conversation in Claude Code (Cmd+Shift+P → "Claude Code: New Conversation") to clear in-memory state.`
                : 'No oversized content found. If Claude Code is still stuck, run "Claude Code: New Conversation" to clear its in-memory state.';
            vscode.window.showInformationMessage(summary);
        })
    );

    const config = vscode.workspace.getConfiguration('claudeToolkit');
    if (config.get('autoRefresh')) {
        const interval = Math.max(10, config.get('refreshInterval') as number || 60) * 1000;
        refreshInterval = setInterval(() => {
            healthProvider.refresh();
            sessionsProvider.refresh();
            statusBar.checkHealth();
        }, interval);
        context.subscriptions.push({ dispose: () => { if (refreshInterval) clearInterval(refreshInterval); } });
    }

    runStartupFlow(context, toolkit, config).catch((err) => {
        output.appendLine(`Startup flow failed: ${err instanceof Error ? err.message : String(err)}`);
    });
}

async function runStartupFlow(
    context: vscode.ExtensionContext,
    toolkit: Toolkit,
    config: vscode.WorkspaceConfiguration
): Promise<void> {
    const health = await toolkit.healthCheck();
    statusBar.update(health);

    if (config.get<boolean>('autoOpenDashboard')) {
        output.appendLine('autoOpenDashboard is enabled — launching dashboard');
        await openDashboard(toolkit, { silent: true });
        return;
    }

    if (!config.get<boolean>('showNotifications') || health.issues === 0) return;
    if (context.globalState.get<boolean>(DISMISS_KEY)) return;

    const open = 'Open Dashboard';
    const dismiss = 'Dismiss';
    const never = "Don't show again";
    const message = `Claude Toolkit: ${health.issues} issue${health.issues === 1 ? '' : 's'} detected`;
    const choice = await vscode.window.showWarningMessage(message, open, dismiss, never);

    if (choice === open) {
        await openDashboard(toolkit);
    } else if (choice === never) {
        await context.globalState.update(DISMISS_KEY, true);
    }
}

async function openDashboard(toolkit: Toolkit, opts: { silent?: boolean } = {}): Promise<void> {
    const config = vscode.workspace.getConfiguration('claudeToolkit');
    const port = config.get<number>('dashboardPort') ?? 1405;

    const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Starting Claude Toolkit dashboard…' },
        () => toolkit.startDashboard(port)
    );

    if (result.success && result.url) {
        await vscode.env.openExternal(vscode.Uri.parse(result.url));
        return;
    }

    const detail = result.error ?? 'Unknown error';
    output.appendLine(`Dashboard failed to start: ${detail}`);
    if (opts.silent) return;

    const showLogs = 'Show Logs';
    const choice = await vscode.window.showErrorMessage(
        `Failed to start dashboard: ${detail}`,
        showLogs
    );
    if (choice === showLogs) output.show();
}

export function deactivate() {
    if (refreshInterval) {
        clearInterval(refreshInterval);
    }
}
