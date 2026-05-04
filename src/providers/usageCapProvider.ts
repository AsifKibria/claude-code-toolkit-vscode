import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface QueuedPrompt {
    id: string;
    prompt: string;
    context?: string;
    priority: 'high' | 'normal' | 'low';
    createdAt: string;
    status: 'queued' | 'sent' | 'skipped';
}

export interface CapStatus {
    state: 'normal' | 'cap_reached';
    resetTime?: string;
    source: 'auto' | 'manual' | 'simulated';
}

interface Config {
    prompts: QueuedPrompt[];
    status: CapStatus;
}

export class UsageCapProvider implements vscode.TreeDataProvider<CapTreeItem>, vscode.Disposable {
    private _onDidChangeTreeData = new vscode.EventEmitter<CapTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private config: Config;
    private configPath: string;
    private timerInterval: NodeJS.Timeout | null = null;
    private watcher: fs.FSWatcher | null = null;

    constructor() {
        this.configPath = path.join(os.homedir(), '.claude', 'prompt-queue.json');
        this.config = this.loadConfig();
        this.startWatching();
    }

    private loadConfig(): Config {
        try {
            if (fs.existsSync(this.configPath)) {
                return JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
            }
        } catch { }
        return {
            prompts: [],
            status: { state: 'normal', source: 'auto' }
        };
    }

    private saveConfig(): void {
        try {
            const dir = path.dirname(this.configPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
        } catch { }
    }

    /** Minimum seconds between consecutive auto-fired cap notifications. */
    private static AUTO_DETECT_COOLDOWN_S = 5 * 60;
    /** Per-file byte offset of the last position we already scanned. Prevents
     *  the same regex hit from firing repeatedly on every file write. */
    private fileOffsets: Map<string, number> = new Map();
    /** Timestamp of the last auto-fired notification (any kind). */
    private lastAutoFireMs = 0;

    private autoDetectEnabled(): boolean {
        return vscode.workspace.getConfiguration('claudeToolkit').get<boolean>('autoDetectCap', false);
    }

    private startWatching(): void {
        this.timerInterval = setInterval(() => this.tick(), 1000);

        // If auto-detect was off and a previous run wrote a stale `cap_reached`
        // entry whose resetTime is already in the past, silently clear it
        // instead of firing a "Cap reset!" toast on every VS Code start.
        if (this.config.status.source === 'auto' &&
            this.config.status.state === 'cap_reached' &&
            this.config.status.resetTime &&
            new Date(this.config.status.resetTime) <= new Date()) {
            this.config.status = { state: 'normal', source: 'auto' };
            this.saveConfig();
        }

        if (!this.autoDetectEnabled()) return;

        const projectsDir = path.join(os.homedir(), '.claude', 'projects');
        if (fs.existsSync(projectsDir)) {
            try {
                this.watcher = fs.watch(projectsDir, { recursive: true }, (_event, filename) => {
                    if (filename && filename.endsWith('.jsonl')) {
                        this.checkLogs();
                    }
                });
            } catch { }
        }
    }

    private tick(): void {
        if (this.config.status.state === 'cap_reached' && this.config.status.resetTime) {
            const resetTime = new Date(this.config.status.resetTime);
            if (new Date() >= resetTime) {
                this.onCapReset();
            }
            this._onDidChangeTreeData.fire();
        }
    }

    private checkLogs(): void {
        if (!this.autoDetectEnabled()) return;
        if (this.config.status.state === 'cap_reached') return;
        // Cooldown: don't fire more than once per AUTO_DETECT_COOLDOWN_S.
        if (Date.now() - this.lastAutoFireMs < UsageCapProvider.AUTO_DETECT_COOLDOWN_S * 1000) return;

        const projectsDir = path.join(os.homedir(), '.claude', 'projects');
        try {
            if (!fs.existsSync(projectsDir)) return;

            const recent: Array<{ path: string; mtime: Date }> = [];
            for (const project of fs.readdirSync(projectsDir)) {
                const projectPath = path.join(projectsDir, project);
                let entries: fs.Dirent[];
                try {
                    entries = fs.readdirSync(projectPath, { withFileTypes: true });
                } catch { continue; }
                for (const entry of entries) {
                    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
                    const full = path.join(projectPath, entry.name);
                    try {
                        recent.push({ path: full, mtime: fs.statSync(full).mtime });
                    } catch { }
                }
            }
            recent.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

            for (const file of recent.slice(0, 3)) {
                let stat: fs.Stats;
                try { stat = fs.statSync(file.path); } catch { continue; }

                // Only scan content APPENDED since the last check on this file.
                // First sighting: anchor at the current end so we never re-scan history.
                const lastOffset = this.fileOffsets.get(file.path);
                if (lastOffset === undefined) {
                    this.fileOffsets.set(file.path, stat.size);
                    continue;
                }
                if (stat.size <= lastOffset) continue;

                let buf: Buffer;
                try {
                    const fd = fs.openSync(file.path, 'r');
                    const readLen = stat.size - lastOffset;
                    buf = Buffer.alloc(readLen);
                    fs.readSync(fd, buf, 0, readLen, lastOffset);
                    fs.closeSync(fd);
                } catch { continue; }
                this.fileOffsets.set(file.path, stat.size);

                const newContent = buf.toString('utf-8');
                if (this.detectCapInDelta(newContent)) {
                    return; // notification fired — stop scanning
                }
            }
        } catch { }
    }

    /**
     * Inspects newly-appended JSONL lines for *real* Anthropic cap signals.
     * Skips user/assistant message content — only matches inside structured
     * error responses or `is_error` tool_result blocks. Returns true if a
     * cap was detected and a notification was fired.
     */
    private detectCapInDelta(deltaText: string): boolean {
        const CAP_PATTERN = /rate[ _-]?limit|usage[ _-]?(cap|limit)|too[ _-]?many[ _-]?requests|429|invalid_request_error.*plan/i;

        for (const rawLine of deltaText.split('\n')) {
            const line = rawLine.trim();
            if (!line || !line.startsWith('{')) continue;

            let entry: Record<string, unknown>;
            try { entry = JSON.parse(line); } catch { continue; }

            // Skip user/assistant message content — that's where false positives live.
            const type = entry.type as string | undefined;
            if (type === 'user' || type === 'assistant') {
                // Special case: assistant messages can carry an `is_error` tool_result block
                // returned by an upstream tool. Walk the content array to check.
                const message = entry.message as Record<string, unknown> | undefined;
                const content = message?.content;
                if (!Array.isArray(content)) continue;
                for (const block of content as Record<string, unknown>[]) {
                    if (block.type !== 'tool_result' || !block.is_error) continue;
                    const inner = typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '');
                    if (CAP_PATTERN.test(inner)) {
                        this.fireCapDetected(inner);
                        return true;
                    }
                }
                continue;
            }

            // Top-level error/system entries — look at the whole serialized line.
            if (type === 'error' || type === 'api_error' || type === 'system') {
                if (CAP_PATTERN.test(line)) {
                    this.fireCapDetected(line);
                    return true;
                }
            }
        }
        return false;
    }

    private fireCapDetected(evidence: string): void {
        this.lastAutoFireMs = Date.now();
        // Try to extract a reset time from the surrounding evidence — Anthropic
        // cap errors sometimes embed something like "resets at 4am" or an ISO ts.
        const tsMatch = evidence.match(/resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
        if (tsMatch) {
            const resetTime = this.parseResetTime(`${tsMatch[1]}${tsMatch[2] ? ':' + tsMatch[2] : ''}${tsMatch[3]}`);
            if (resetTime) { this.setCapReachedWithTime(resetTime); return; }
        }
        this.setCapReached(60);
    }

    private setCapReachedWithTime(resetTime: Date): void {
        this.config.status = {
            state: 'cap_reached',
            resetTime: resetTime.toISOString(),
            source: 'auto'
        };
        this.saveConfig();
        this._onDidChangeTreeData.fire();

        const timeStr = resetTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const queuedCount = this.config.prompts.filter(p => p.status === 'queued').length;

        vscode.window.showWarningMessage(
            `🚫 Usage cap detected! Resets at ${timeStr}` +
            (queuedCount > 0 ? ` • ${queuedCount} prompt(s) queued` : ''),
            'Add Prompt', 'View Queue'
        ).then(choice => {
            if (choice === 'Add Prompt') this.addPrompt();
        });
    }

    private setCapReached(minutes: number): void {
        this.config.status = {
            state: 'cap_reached',
            resetTime: new Date(Date.now() + minutes * 60000).toISOString(),
            source: 'auto'
        };
        this.saveConfig();
        this._onDidChangeTreeData.fire();

        const queuedCount = this.config.prompts.filter(p => p.status === 'queued').length;
        vscode.window.showWarningMessage(
            `🚫 Usage cap reached! Reset in ~${minutes} min.` +
            (queuedCount > 0 ? ` You have ${queuedCount} prompt(s) queued.` : ''),
            'Add Prompt'
        ).then(choice => {
            if (choice === 'Add Prompt') this.addPrompt();
        });
    }

    private onCapReset(): void {
        this.config.status = { state: 'normal', source: 'auto' };
        this.saveConfig();
        this._onDidChangeTreeData.fire();

        const queued = this.config.prompts.filter(p => p.status === 'queued');
        if (queued.length > 0) {
            // Automatically send the first queued prompt!
            this.autoSendOnReset();
        } else {
            vscode.window.showInformationMessage('✅ Usage cap reset! Claude is ready.');
        }
    }

    // Set cap with specific reset time (e.g., "4am", "3:30pm")
    async setCapWithResetTime(): Promise<void> {
        const timeInput = await vscode.window.showInputBox({
            prompt: 'When does the cap reset? (e.g., 4am, 3:30pm, 14:00)',
            placeHolder: '4am'
        });

        if (!timeInput) return;

        const resetTime = this.parseResetTime(timeInput);
        if (!resetTime) {
            vscode.window.showErrorMessage('Could not parse time. Use format like: 4am, 3:30pm, 14:00');
            return;
        }

        this.config.status = {
            state: 'cap_reached',
            resetTime: resetTime.toISOString(),
            source: 'manual'
        };
        this.saveConfig();
        this._onDidChangeTreeData.fire();

        const timeStr = resetTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        vscode.window.showInformationMessage(`⏰ Cap set to reset at ${timeStr}`);
    }

    private parseResetTime(input: string): Date | null {
        const now = new Date();
        const cleaned = input.toLowerCase().trim();

        // Try parsing "4am", "3:30pm", etc.
        const match = cleaned.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
        if (match) {
            let hours = parseInt(match[1]);
            const minutes = match[2] ? parseInt(match[2]) : 0;
            const ampm = match[3];

            if (ampm === 'pm' && hours < 12) hours += 12;
            if (ampm === 'am' && hours === 12) hours = 0;

            const resetTime = new Date(now);
            resetTime.setHours(hours, minutes, 0, 0);

            // If time is in the past, assume tomorrow
            if (resetTime <= now) {
                resetTime.setDate(resetTime.getDate() + 1);
            }

            return resetTime;
        }

        // Try parsing 24h format "14:00"
        const match24 = cleaned.match(/^(\d{1,2}):(\d{2})$/);
        if (match24) {
            const hours = parseInt(match24[1]);
            const minutes = parseInt(match24[2]);

            const resetTime = new Date(now);
            resetTime.setHours(hours, minutes, 0, 0);

            if (resetTime <= now) {
                resetTime.setDate(resetTime.getDate() + 1);
            }

            return resetTime;
        }

        return null;
    }

    // ─── Public Commands ────────────────────────────────────────────

    async addPrompt(): Promise<void> {
        // Show a multi-line input for the prompt
        const prompt = await vscode.window.showInputBox({
            prompt: 'What do you want Claude to do?',
            placeHolder: 'e.g., Fix the bug in auth.ts, Add unit tests for utils...',
            ignoreFocusOut: true
        });
        if (!prompt) return;

        // Optional context
        const addContext = await vscode.window.showQuickPick(
            ['No additional context', 'Add file/context reference'],
            { placeHolder: 'Add context?' }
        );

        let context: string | undefined;
        if (addContext === 'Add file/context reference') {
            context = await vscode.window.showInputBox({
                prompt: 'Context (file paths, notes, etc.)',
                placeHolder: 'e.g., See src/auth.ts:45, related to PR #123'
            });
        }

        // Priority
        const priority = await vscode.window.showQuickPick([
            { label: '🔴 High', description: 'Do this first', value: 'high' as const },
            { label: '🟡 Normal', description: 'Regular priority', value: 'normal' as const },
            { label: '🟢 Low', description: 'When you get to it', value: 'low' as const }
        ], { placeHolder: 'Priority?' });

        const newPrompt: QueuedPrompt = {
            id: Date.now().toString(36),
            prompt,
            context,
            priority: priority?.value || 'normal',
            createdAt: new Date().toISOString(),
            status: 'queued'
        };

        this.config.prompts.unshift(newPrompt);
        this.sortPrompts();
        this.saveConfig();
        this._onDidChangeTreeData.fire();

        vscode.window.showInformationMessage(`✓ Prompt queued${this.config.status.state === 'cap_reached' ? ' - will notify when cap resets' : ''}`);
    }

    async addQuickPrompt(): Promise<void> {
        const prompt = await vscode.window.showInputBox({
            prompt: 'Quick prompt for Claude',
            placeHolder: 'What should Claude do?'
        });

        if (prompt) {
            this.config.prompts.unshift({
                id: Date.now().toString(36),
                prompt,
                priority: 'normal',
                createdAt: new Date().toISOString(),
                status: 'queued'
            });
            this.saveConfig();
            this._onDidChangeTreeData.fire();
        }
    }

    async sendPrompt(promptId: string): Promise<void> {
        const prompt = this.config.prompts.find(p => p.id === promptId);
        if (!prompt) return;

        let message = prompt.prompt;
        if (prompt.context) {
            message += `\n\nContext: ${prompt.context}`;
        }

        const target = await this.pickSendTarget();
        if (!target) return;

        const sent = target === 'chat'
            ? await this.sendToChat(message)
            : await this.sendToTerminal(message);

        if (sent) {
            prompt.status = 'sent';
            this.saveConfig();
            this._onDidChangeTreeData.fire();
        }
    }

    private async pickSendTarget(): Promise<'chat' | 'terminal' | undefined> {
        const config = vscode.workspace.getConfiguration('claudeToolkit');
        const remembered = config.get<string>('defaultSendTarget');
        if (remembered === 'chat' || remembered === 'terminal') {
            return remembered;
        }

        const choice = await vscode.window.showQuickPick([
            { label: '$(comment-discussion) Send to Chat', description: 'Paste into the Claude Code panel', value: 'chat' as const },
            { label: '$(terminal) Send to Terminal', description: 'Run via the claude CLI in a new terminal', value: 'terminal' as const }
        ], { placeHolder: 'Where should this prompt go?' });

        return choice?.value;
    }

    private async sendToChat(message: string): Promise<boolean> {
        try {
            await vscode.env.clipboard.writeText(message);
        } catch {
            vscode.window.showErrorMessage('Could not copy prompt to clipboard.');
            return false;
        }

        const chatCommands = [
            'claude-vscode.sidebar.open',
            'claude-vscode.editor.openLast',
            'claude-vscode.focus'
        ];
        let opened = false;
        for (const cmd of chatCommands) {
            try {
                await vscode.commands.executeCommand(cmd);
                opened = true;
                break;
            } catch { /* try the next one */ }
        }
        try { await vscode.commands.executeCommand('claude-vscode.focus'); } catch { /* optional */ }

        if (!opened) {
            vscode.window.showWarningMessage(
                'Prompt copied to clipboard. Open the Claude Code panel and paste it (Cmd/Ctrl+V).'
            );
            return true;
        }

        vscode.window.showInformationMessage(
            'Prompt copied — Claude Code chat focused. Press Cmd/Ctrl+V then Enter.'
        );
        return true;
    }

    private async sendToTerminal(message: string): Promise<boolean> {
        // Multi-line prompts can't survive shell quoting reliably,
        // so write the prompt to a temp file and pipe it into claude.
        const tmpDir = path.join(os.tmpdir(), 'claude-toolkit-prompts');
        try {
            if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
        } catch {
            vscode.window.showErrorMessage('Could not create temp directory for prompt.');
            return false;
        }

        const tmpPath = path.join(tmpDir, `prompt-${Date.now()}.txt`);
        try {
            fs.writeFileSync(tmpPath, message, 'utf-8');
        } catch {
            vscode.window.showErrorMessage('Could not write prompt to disk.');
            return false;
        }

        let terminal = vscode.window.terminals.find(t => t.name === 'Claude Queue');
        if (!terminal) {
            terminal = vscode.window.createTerminal('Claude Queue');
        }
        terminal.show();

        const isWin = process.platform === 'win32';
        const command = isWin
            ? `Get-Content -Raw "${tmpPath}" | claude`
            : `cat "${tmpPath}" | claude`;
        terminal.sendText(command, true);

        vscode.window.showInformationMessage('Prompt sent to Claude terminal.');
        return true;
    }

    async autoSendOnReset(): Promise<void> {
        const queued = this.config.prompts.filter(p => p.status === 'queued');
        if (queued.length === 0) return;

        const sorted = [...queued].sort((a, b) => {
            const order = { high: 0, normal: 1, low: 2 };
            return order[a.priority] - order[b.priority];
        });

        const first = sorted[0];

        let message = first.prompt;
        if (first.context) {
            message += `\n\nContext: ${first.context}`;
        }

        const action = await vscode.window.showInformationMessage(
            `Cap reset! Send queued prompt: "${first.prompt.slice(0, 40)}${first.prompt.length > 40 ? '...' : ''}"?`,
            'Send', 'Skip'
        );
        if (action !== 'Send') return;

        const target = await this.pickSendTarget();
        if (!target) return;

        const sent = target === 'chat'
            ? await this.sendToChat(message)
            : await this.sendToTerminal(message);
        if (sent) {
            first.status = 'sent';
            this.saveConfig();
            this._onDidChangeTreeData.fire();
        }
    }

    async editPrompt(promptId: string): Promise<void> {
        const prompt = this.config.prompts.find(p => p.id === promptId);
        if (!prompt) return;

        const newText = await vscode.window.showInputBox({
            value: prompt.prompt,
            prompt: 'Edit prompt'
        });

        if (newText) {
            prompt.prompt = newText;
            this.saveConfig();
            this._onDidChangeTreeData.fire();
        }
    }

    removePrompt(promptId: string): void {
        this.config.prompts = this.config.prompts.filter(p => p.id !== promptId);
        this.saveConfig();
        this._onDidChangeTreeData.fire();
    }

    setPriority(promptId: string, priority: 'high' | 'normal' | 'low'): void {
        const prompt = this.config.prompts.find(p => p.id === promptId);
        if (prompt) {
            prompt.priority = priority;
            this.sortPrompts();
            this.saveConfig();
            this._onDidChangeTreeData.fire();
        }
    }

    private sortPrompts(): void {
        const order = { high: 0, normal: 1, low: 2 };
        this.config.prompts.sort((a, b) => {
            if (a.status !== b.status) {
                return a.status === 'queued' ? -1 : 1;
            }
            return order[a.priority] - order[b.priority];
        });
    }

    clearSent(): void {
        this.config.prompts = this.config.prompts.filter(p => p.status === 'queued');
        this.saveConfig();
        this._onDidChangeTreeData.fire();
    }

    async simulateCapReached(): Promise<void> {
        const input = await vscode.window.showQuickPick([
            { label: '⚡ 1 minute', value: 1 },
            { label: '🕐 5 minutes', value: 5 },
            { label: '🕑 15 minutes', value: 15 }
        ], { placeHolder: 'Simulate cap for...' });

        if (input) {
            this.config.status = {
                state: 'cap_reached',
                resetTime: new Date(Date.now() + input.value * 60000).toISOString(),
                source: 'simulated'
            };
            this.saveConfig();
            this._onDidChangeTreeData.fire();
            vscode.window.showInformationMessage(`🧪 Simulated cap for ${input.value} min`);
        }
    }

    clearCapStatus(): void {
        this.config.status = { state: 'normal', source: 'manual' };
        this.saveConfig();
        this._onDidChangeTreeData.fire();
    }

    getStatus(): CapStatus {
        return this.config.status;
    }

    refresh(): void {
        this.config = this.loadConfig();
        this._onDidChangeTreeData.fire();
    }

    // ─── Tree Data Provider ─────────────────────────────────────────

    getTreeItem(element: CapTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: CapTreeItem): CapTreeItem[] {
        if (element) return [];

        const items: CapTreeItem[] = [];
        const queued = this.config.prompts.filter(p => p.status === 'queued');
        const sent = this.config.prompts.filter(p => p.status === 'sent');

        // ═══ STATUS CARD ═══
        items.push(this.createStatusCard());

        // ═══ QUEUE SECTION ═══
        const queueHeader = new CapTreeItem('', 'section-header');
        queueHeader.label = `Queue`;
        queueHeader.description = queued.length > 0 ? `${queued.length} pending` : 'empty';
        queueHeader.iconPath = new vscode.ThemeIcon('layers', new vscode.ThemeColor('charts.blue'));
        items.push(queueHeader);

        if (queued.length === 0) {
            const empty = new CapTreeItem('', 'empty-state');
            empty.label = 'No prompts queued';
            empty.description = 'Add what you want Claude to do';
            empty.iconPath = new vscode.ThemeIcon('inbox');
            items.push(empty);
        } else {
            for (const prompt of queued) {
                items.push(this.createPromptCard(prompt));
            }
        }

        // Add Prompt Button
        const addBtn = new CapTreeItem('', 'action-primary');
        addBtn.label = 'Add Prompt';
        addBtn.iconPath = new vscode.ThemeIcon('add', new vscode.ThemeColor('charts.green'));
        addBtn.command = { command: 'claudeToolkit.addCapTask', title: 'Add' };
        addBtn.tooltip = 'Queue a new prompt for Claude';
        items.push(addBtn);

        // ═══ HISTORY SECTION ═══
        if (sent.length > 0) {
            const historyHeader = new CapTreeItem('', 'section-header');
            historyHeader.label = `History`;
            historyHeader.description = `${sent.length} sent`;
            historyHeader.iconPath = new vscode.ThemeIcon('history', new vscode.ThemeColor('descriptionForeground'));
            items.push(historyHeader);

            for (const prompt of sent.slice(0, 3)) {
                items.push(this.createSentCard(prompt));
            }

            if (sent.length > 3) {
                const more = new CapTreeItem('', 'more-link');
                more.label = `+ ${sent.length - 3} more`;
                more.iconPath = new vscode.ThemeIcon('ellipsis');
                items.push(more);
            }

            // Clear History
            const clearBtn = new CapTreeItem('', 'action-secondary');
            clearBtn.label = 'Clear History';
            clearBtn.iconPath = new vscode.ThemeIcon('trash', new vscode.ThemeColor('descriptionForeground'));
            clearBtn.command = { command: 'claudeToolkit.clearSentPrompts', title: 'Clear' };
            items.push(clearBtn);
        }

        // ═══ SETTINGS SECTION ═══
        const settingsHeader = new CapTreeItem('', 'section-header');
        settingsHeader.label = 'Settings';
        settingsHeader.iconPath = new vscode.ThemeIcon('settings-gear', new vscode.ThemeColor('descriptionForeground'));
        items.push(settingsHeader);

        const setTime = new CapTreeItem('', 'action-secondary');
        setTime.label = 'Set Reset Time';
        setTime.description = 'e.g., 4am';
        setTime.iconPath = new vscode.ThemeIcon('clock');
        setTime.command = { command: 'claudeToolkit.setCapResetTime', title: 'Set' };
        setTime.tooltip = 'Enter when your usage cap resets';
        items.push(setTime);

        const testBtn = new CapTreeItem('', 'action-secondary');
        testBtn.label = 'Test Mode';
        testBtn.description = 'simulate cap';
        testBtn.iconPath = new vscode.ThemeIcon('beaker');
        testBtn.command = { command: 'claudeToolkit.simulateCapReached', title: 'Test' };
        items.push(testBtn);

        return items;
    }

    private createStatusCard(): CapTreeItem {
        const status = this.config.status;
        const queued = this.config.prompts.filter(p => p.status === 'queued').length;

        if (status.state === 'cap_reached' && status.resetTime) {
            const resetTime = new Date(status.resetTime);
            const remaining = Math.max(0, Math.ceil((resetTime.getTime() - Date.now()) / 60000));
            const hours = Math.floor(remaining / 60);
            const mins = remaining % 60;
            const timeStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

            const item = new CapTreeItem('', 'status-cap');
            item.label = `⏸ Cap Active`;
            item.description = `resets in ${timeStr}`;
            item.iconPath = new vscode.ThemeIcon('debug-pause', new vscode.ThemeColor('errorForeground'));
            item.tooltip = new vscode.MarkdownString(
                `### 🚫 Usage Cap Reached\n\n` +
                `**Resets at:** ${resetTime.toLocaleTimeString()}\n\n` +
                `**Queued:** ${queued} prompt${queued !== 1 ? 's' : ''}\n\n` +
                `---\n` +
                `Your queued prompts will be ready when the cap resets.\n\n` +
                `*Click to clear status*`
            );
            item.command = { command: 'claudeToolkit.clearCapStatus', title: 'Clear' };
            return item;
        }

        const item = new CapTreeItem('', 'status-ready');
        item.label = `✓ Ready`;
        item.description = queued > 0 ? `${queued} queued` : 'Claude available';
        item.iconPath = new vscode.ThemeIcon('check-all', new vscode.ThemeColor('testing.iconPassed'));
        item.tooltip = new vscode.MarkdownString(
            `### ✅ Claude Ready\n\n` +
            `No usage cap active.\n\n` +
            (queued > 0 ? `**${queued}** prompt${queued !== 1 ? 's' : ''} in queue.` : `Queue prompts for later.`)
        );
        return item;
    }

    private createPromptCard(prompt: QueuedPrompt): CapTreeItem {
        const item = new CapTreeItem('', 'prompt-card');

        // Truncate preview
        const maxLen = 40;
        const preview = prompt.prompt.length > maxLen
            ? prompt.prompt.slice(0, maxLen - 1) + '…'
            : prompt.prompt;

        item.label = preview;

        // Priority indicator + context
        const priorityLabel = { high: 'HIGH', normal: '', low: 'low' }[prompt.priority];
        const contextIndicator = prompt.context ? ' 📎' : '';
        item.description = priorityLabel + contextIndicator;

        // Priority-based icon color
        const iconColor = {
            high: 'errorForeground',
            normal: 'charts.blue',
            low: 'descriptionForeground'
        }[prompt.priority];

        item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(iconColor));
        item.promptId = prompt.id;
        item.contextValue = 'queuedPrompt';

        // Rich tooltip
        const addedTime = new Date(prompt.createdAt);
        const timeAgo = this.formatTimeAgo(addedTime);

        item.tooltip = new vscode.MarkdownString(
            `### ${prompt.priority === 'high' ? '🔴 High Priority' : prompt.priority === 'low' ? '🟢 Low Priority' : '🟡 Normal Priority'}\n\n` +
            `\`\`\`\n${prompt.prompt}\n\`\`\`\n\n` +
            (prompt.context ? `**Context:** ${prompt.context}\n\n` : '') +
            `*Added ${timeAgo}*\n\n` +
            `---\n` +
            `**Click** to copy & send to Claude`
        );

        item.command = {
            command: 'claudeToolkit.sendPrompt',
            title: 'Send',
            arguments: [prompt.id]
        };

        return item;
    }

    private createSentCard(prompt: QueuedPrompt): CapTreeItem {
        const item = new CapTreeItem('', 'sent-card');

        const maxLen = 35;
        const preview = prompt.prompt.length > maxLen
            ? prompt.prompt.slice(0, maxLen - 1) + '…'
            : prompt.prompt;

        item.label = preview;
        item.description = this.formatTimeAgo(new Date(prompt.createdAt));
        item.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));

        item.tooltip = new vscode.MarkdownString(
            `### ✓ Sent\n\n` +
            `\`\`\`\n${prompt.prompt}\n\`\`\`\n\n` +
            (prompt.context ? `**Context:** ${prompt.context}\n\n` : '')
        );

        return item;
    }

    private formatTimeAgo(date: Date): string {
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

    dispose(): void {
        this.watcher?.close();
        if (this.timerInterval) clearInterval(this.timerInterval);
    }
}

export class CapTreeItem extends vscode.TreeItem {
    promptId?: string;

    constructor(label: string, public readonly itemType: string) {
        super(label, vscode.TreeItemCollapsibleState.None);
    }
}
