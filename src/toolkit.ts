import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export interface HealthResult {
    healthy: boolean;
    issues: number;
    warnings: string[];
    diskUsage: { used: number; total: number };
    sessionCount: number;
    lastCheck: Date;
}

export interface SessionInfo {
    id: string;
    project: string;
    modified: Date;
    sizeBytes: number;
    messageCount: number;
    filePath: string;
    starred?: boolean;
    tags?: string[];
    health: 'healthy' | 'corrupted' | 'empty' | 'orphaned';
}

export interface SearchResult {
    sessionId: string;
    file: string;
    project: string;
    role: string;
    preview: string;
    line: number;
}

export interface MaintenanceResult {
    cleaned: number;
    freedBytes: string;
    issues: string[];
}

export interface SecurityResult {
    issues: number;
    findings: Array<{ type: string; file: string; detail: string }>;
}

export interface ConversationMessage {
    type: string;
    role?: string;
    content?: string;
    timestamp?: string;
}

export type LogFn = (message: string) => void;

export class Toolkit {
    private claudeDir: string;
    private projectsDir: string;
    private bookmarksPath: string;
    private log: LogFn = () => {};

    constructor() {
        this.claudeDir = path.join(os.homedir(), '.claude');
        this.projectsDir = path.join(this.claudeDir, 'projects');
        this.bookmarksPath = path.join(this.claudeDir, 'bookmarks.json');
    }

    setLogger(fn: LogFn): void {
        this.log = fn;
    }

    async healthCheck(): Promise<HealthResult> {
        const warnings: string[] = [];
        let sessionCount = 0;
        let totalSize = 0;

        try {
            // Check if .claude directory exists
            if (!fs.existsSync(this.claudeDir)) {
                return {
                    healthy: false,
                    issues: 1,
                    warnings: ['Claude directory not found (~/.claude)'],
                    diskUsage: { used: 0, total: 0 },
                    sessionCount: 0,
                    lastCheck: new Date()
                };
            }

            // Count sessions and check for issues
            const sessions = await this.listSessions(1000);
            sessionCount = sessions.length;

            for (const session of sessions) {
                totalSize += session.sizeBytes;
                if (session.health === 'corrupted') {
                    warnings.push(`Corrupted session: ${session.id.slice(0, 8)}`);
                }
                if (session.sizeBytes > 50 * 1024 * 1024) {
                    warnings.push(`Large session (${this.formatBytes(session.sizeBytes)}): ${session.id.slice(0, 8)}`);
                }
            }

            // Check disk usage
            if (totalSize > 500 * 1024 * 1024) {
                warnings.push(`High disk usage: ${this.formatBytes(totalSize)}`);
            }

            return {
                healthy: warnings.length === 0,
                issues: warnings.length,
                warnings,
                diskUsage: { used: totalSize, total: 0 },
                sessionCount,
                lastCheck: new Date()
            };
        } catch (error) {
            this.log(`healthCheck failed: ${error instanceof Error ? error.message : String(error)}`);
            return {
                healthy: false,
                issues: 1,
                warnings: ['Health check failed — see Claude Toolkit output for details'],
                diskUsage: { used: 0, total: 0 },
                sessionCount: 0,
                lastCheck: new Date()
            };
        }
    }

    async listSessions(limit = 20): Promise<SessionInfo[]> {
        const sessions: SessionInfo[] = [];

        try {
            try { await fsp.access(this.projectsDir); } catch { return sessions; }

            const bookmarks = await this.loadBookmarks();
            const projectDirs = await fsp.readdir(this.projectsDir);

            await Promise.all(projectDirs.map(async (projectName) => {
                const projectPath = path.join(this.projectsDir, projectName);
                try {
                    const stat = await fsp.stat(projectPath);
                    if (!stat.isDirectory()) return;
                } catch { return; }

                const entries = await fsp.readdir(projectPath);
                const jsonlFiles = entries.filter(f => f.endsWith('.jsonl'));

                await Promise.all(jsonlFiles.map(async (file) => {
                    const filePath = path.join(projectPath, file);
                    try {
                        const stats = await fsp.stat(filePath);
                        const sessionId = file.replace('.jsonl', '');
                        const session: SessionInfo = {
                            id: sessionId,
                            project: this.decodeProjectName(projectName),
                            modified: stats.mtime,
                            sizeBytes: stats.size,
                            messageCount: await this.quickCountMessages(filePath),
                            filePath,
                            starred: bookmarks.includes(sessionId),
                            health: await this.checkSessionHealth(filePath)
                        };
                        sessions.push(session);
                    } catch { /* skip unreadable files */ }
                }));
            }));

            sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
            return sessions.slice(0, limit);
        } catch (error) {
            console.error('Error listing sessions:', error);
            return sessions;
        }
    }

    private async quickCountMessages(filePath: string): Promise<number> {
        try {
            const content = await fsp.readFile(filePath, 'utf-8');
            let count = 0;
            for (const line of content.split('\n')) {
                if (line.trim()) {
                    try {
                        const obj = JSON.parse(line);
                        if (obj.type === 'user' || obj.type === 'assistant') count++;
                    } catch { /* skip */ }
                }
            }
            return count;
        } catch {
            return 0;
        }
    }

    private async checkSessionHealth(filePath: string): Promise<'healthy' | 'corrupted' | 'empty' | 'orphaned'> {
        try {
            const stats = await fsp.stat(filePath);
            if (stats.size === 0) return 'empty';

            const content = await fsp.readFile(filePath, 'utf-8');
            const lines = content.split('\n').filter(l => l.trim());
            if (lines.length === 0) return 'empty';

            try {
                JSON.parse(lines[0]);
                JSON.parse(lines[lines.length - 1]);
            } catch {
                return 'corrupted';
            }
            return 'healthy';
        } catch {
            return 'corrupted';
        }
    }

    private decodeProjectName(encoded: string): string {
        return encoded.replace(/-/g, '/');
    }

    async getStarredSessions(): Promise<SessionInfo[]> {
        const bookmarks = await this.loadBookmarks();
        const allSessions = await this.listSessions(500);
        return allSessions.filter(s => bookmarks.includes(s.id));
    }

    private async loadBookmarks(): Promise<string[]> {
        try {
            const data = JSON.parse(await fsp.readFile(this.bookmarksPath, 'utf-8'));
            return data.bookmarks || [];
        } catch {
            return [];
        }
    }

    private async saveBookmarks(bookmarks: string[]): Promise<void> {
        try {
            await fsp.mkdir(path.dirname(this.bookmarksPath), { recursive: true });
            await fsp.writeFile(this.bookmarksPath, JSON.stringify({ bookmarks }, null, 2));
        } catch (error) {
            console.error('Failed to save bookmarks:', error);
        }
    }

    async starSession(sessionId: string): Promise<void> {
        const bookmarks = await this.loadBookmarks();
        if (!bookmarks.includes(sessionId)) {
            bookmarks.push(sessionId);
            await this.saveBookmarks(bookmarks);
        }
    }

    async unstarSession(sessionId: string): Promise<void> {
        const bookmarks = await this.loadBookmarks();
        await this.saveBookmarks(bookmarks.filter(b => b !== sessionId));
    }

    async searchConversations(query: string, limit = 50): Promise<SearchResult[]> {
        const results: SearchResult[] = [];
        const lowerQuery = query.toLowerCase();

        try {
            const sessions = await this.listSessions(500);

            for (const session of sessions) {
                if (results.length >= limit) break;

                try {
                    const content = await fsp.readFile(session.filePath, 'utf-8');
                    const lines = content.split('\n');

                    for (let i = 0; i < lines.length; i++) {
                        if (results.length >= limit) break;

                        const line = lines[i];
                        if (!line.trim()) continue;

                        try {
                            const obj = JSON.parse(line);
                            const text = this.extractText(obj);

                            if (text.toLowerCase().includes(lowerQuery)) {
                                results.push({
                                    sessionId: session.id,
                                    file: session.filePath,
                                    project: session.project,
                                    role: obj.type || 'unknown',
                                    preview: text.slice(0, 150),
                                    line: i + 1
                                });
                            }
                        } catch {
                            // Skip invalid lines
                        }
                    }
                } catch {
                    // Skip unreadable files
                }
            }
        } catch (error) {
            console.error('Search error:', error);
        }

        return results;
    }

    private extractText(obj: any): string {
        if (typeof obj.content === 'string') return obj.content;
        if (Array.isArray(obj.content)) {
            return obj.content
                .filter((c: any) => c.type === 'text')
                .map((c: any) => c.text || '')
                .join(' ');
        }
        if (obj.message?.content) {
            return this.extractText(obj.message);
        }
        return '';
    }

    async getSession(sessionId: string): Promise<SessionInfo | null> {
        const sessions = await this.listSessions(500);
        return sessions.find(s => s.id === sessionId || s.id.startsWith(sessionId)) || null;
    }

    async getSessionMessages(sessionId: string): Promise<ConversationMessage[]> {
        const session = await this.getSession(sessionId);
        if (!session) return [];

        const messages: ConversationMessage[] = [];

        try {
            const content = await fsp.readFile(session.filePath, 'utf-8');
            for (const line of content.split('\n')) {
                if (!line.trim()) continue;
                try {
                    const obj = JSON.parse(line);
                    messages.push({
                        type: obj.type,
                        role: obj.type,
                        content: this.extractText(obj),
                        timestamp: obj.timestamp
                    });
                } catch {
                    // Skip invalid lines
                }
            }
        } catch (error) {
            console.error('Error reading session:', error);
        }

        return messages;
    }

    async exportSession(sessionId: string, format: string, outputPath: string): Promise<{ success: boolean; error?: string }> {
        try {
            const session = await this.getSession(sessionId);
            if (!session) {
                return { success: false, error: 'Session not found' };
            }

            const messages = await this.getSessionMessages(sessionId);

            let output = '';

            if (format === 'json') {
                output = JSON.stringify(messages, null, 2);
            } else if (format === 'markdown' || format === 'md') {
                output = `# Conversation: ${session.id.slice(0, 8)}\n\n`;
                output += `**Project:** ${session.project}\n`;
                output += `**Date:** ${session.modified.toISOString()}\n\n---\n\n`;

                for (const msg of messages) {
                    if (msg.type === 'user' || msg.type === 'assistant') {
                        output += `## ${msg.type === 'user' ? 'User' : 'Assistant'}\n\n`;
                        output += msg.content + '\n\n';
                    }
                }
            } else if (format === 'html') {
                output = this.generateHtml(session, messages);
            }

            await fsp.writeFile(outputPath, output);
            return { success: true };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    }

    private generateHtml(session: SessionInfo, messages: ConversationMessage[]): string {
        let html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>Conversation ${session.id.slice(0, 8)}</title>
<style>
body { font-family: -apple-system, system-ui, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; background: #1a1a2e; color: #eee; }
.message { margin: 16px 0; padding: 16px; border-radius: 8px; }
.user { background: #16213e; border-left: 3px solid #0f4c75; }
.assistant { background: #1a1a2e; border-left: 3px solid #3282b8; }
.role { font-weight: bold; margin-bottom: 8px; color: #3282b8; }
pre { background: #0f0f23; padding: 12px; border-radius: 4px; overflow-x: auto; }
code { font-family: 'SF Mono', Monaco, monospace; }
</style>
</head><body>
<h1>Conversation ${session.id.slice(0, 8)}</h1>
<p><strong>Project:</strong> ${session.project}</p>
<p><strong>Date:</strong> ${session.modified.toISOString()}</p>
<hr>
`;
        for (const msg of messages) {
            if (msg.type === 'user' || msg.type === 'assistant') {
                const roleClass = msg.type;
                const content = this.escapeHtml(msg.content || '')
                    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
                    .replace(/`([^`]+)`/g, '<code>$1</code>')
                    .replace(/\n/g, '<br>');

                html += `<div class="message ${roleClass}">
<div class="role">${msg.type === 'user' ? 'User' : 'Assistant'}</div>
<div class="content">${content}</div>
</div>\n`;
            }
        }

        html += '</body></html>';
        return html;
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    async archiveSession(sessionId: string): Promise<void> {
        const session = await this.getSession(sessionId);
        if (!session) return;

        const archiveDir = path.join(this.claudeDir, 'archive');
        await fsp.mkdir(archiveDir, { recursive: true });

        const baseName = path.basename(session.filePath);
        const archivePath = path.join(archiveDir, baseName);
        const dest = fs.existsSync(archivePath)
            ? path.join(archiveDir, `${Date.now()}-${baseName}`)
            : archivePath;
        await fsp.rename(session.filePath, dest);
    }

    async deleteSession(sessionId: string): Promise<void> {
        const session = await this.getSession(sessionId);
        if (!session) return;

        await fsp.unlink(session.filePath);
        await this.unstarSession(sessionId);
    }

    async fixSession(sessionId?: string): Promise<{ scanned: number; fixed: number; errors: string[] }> {
        const errors: string[] = [];
        let scanned = 0;
        let fixed = 0;

        const sessions = sessionId
            ? [await this.getSession(sessionId)].filter((s): s is SessionInfo => Boolean(s))
            : await this.listSessions(1000);

        for (const session of sessions) {
            scanned++;
            const fixedThis = await this.scrubOversizedContent(session.filePath).catch((err) => {
                errors.push(`${session.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
                return 0;
            });
            if (fixedThis > 0) fixed += 1;
        }
        return { scanned, fixed, errors };
    }

    async unstickSession(sessionId: string): Promise<{ ok: boolean; reason?: string; scrubbed: number }> {
        const session = await this.getSession(sessionId);
        if (!session) return { ok: false, reason: 'Session not found', scrubbed: 0 };

        const scrubbed = await this.scrubOversizedContent(session.filePath).catch(() => 0);

        // Drop any per-session warning state Claude Code keeps next to it.
        // These flags are what cause a "stuck" session to keep replaying the same error.
        const warningPath = path.join(this.claudeDir, `security_warnings_state_${sessionId}.json`);
        try { if (fs.existsSync(warningPath)) await fsp.unlink(warningPath); } catch { /* best-effort */ }

        return { ok: true, scrubbed };
    }

    private async scrubOversizedContent(filePath: string): Promise<number> {
        const MAX_BASE64 = 200 * 1024; // ~200 KB before encoding overhead — matches CLI default
        const MAX_TEXT = 100 * 1024;

        let raw: string;
        try { raw = await fsp.readFile(filePath, 'utf-8'); } catch { return 0; }

        const lines = raw.split('\n');
        let modifications = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line.trim()) continue;
            let entry: any;
            try { entry = JSON.parse(line); } catch { continue; }

            const content = entry?.message?.content ?? entry?.content;
            if (!Array.isArray(content)) continue;

            let changed = false;
            for (let j = 0; j < content.length; j++) {
                const item = content[j];
                if (!item || typeof item !== 'object') continue;
                const replacement = this.replacementForOversized(item, MAX_BASE64, MAX_TEXT);
                if (replacement) {
                    content[j] = replacement;
                    changed = true;
                }
            }

            if (changed) {
                lines[i] = JSON.stringify(entry);
                modifications++;
            }
        }

        if (modifications === 0) return 0;

        const backupDir = path.join(this.claudeDir, 'backups');
        try { await fsp.mkdir(backupDir, { recursive: true }); } catch { /* best-effort */ }
        const backupPath = path.join(backupDir, `${path.basename(filePath)}.${Date.now()}.bak`);
        try { await fsp.copyFile(filePath, backupPath); } catch { /* best-effort */ }

        await fsp.writeFile(filePath, lines.join('\n'), 'utf-8');
        return modifications;
    }

    private replacementForOversized(item: any, maxBase64: number, maxText: number): any | null {
        if (item.type === 'image' || item.type === 'document') {
            const data = item?.source?.data;
            if (typeof data === 'string' && data.length > maxBase64) {
                const label = item.type === 'document' && item?.source?.media_type?.includes('pdf') ? 'PDF' : item.type === 'document' ? 'Document' : 'Image';
                return { type: 'text', text: `[${label} removed by Claude Toolkit — exceeded ${Math.round(maxBase64 / 1024)} KB limit]` };
            }
        }
        if (item.type === 'text' && typeof item.text === 'string' && item.text.length > maxText) {
            return { type: 'text', text: `[Text content truncated by Claude Toolkit — was ${item.text.length} chars]\n\n${item.text.slice(0, maxText)}` };
        }
        return null;
    }

    async runMaintenance(): Promise<MaintenanceResult> {
        let cleaned = 0;
        let freedBytes = 0;

        try {
            // Clean empty sessions
            const sessions = await this.listSessions(1000);

            for (const session of sessions) {
                if (session.health === 'empty' || session.sizeBytes === 0) {
                    try {
                        await fsp.unlink(session.filePath);
                        freedBytes += session.sizeBytes;
                        cleaned++;
                    } catch {
                        // Skip files we can't delete
                    }
                }
            }

            // Clean old backups
            const backupDir = path.join(this.claudeDir, 'backups');
            if (fs.existsSync(backupDir)) {
                const now = Date.now();
                const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days

                for (const file of fs.readdirSync(backupDir)) {
                    const filePath = path.join(backupDir, file);
                    try {
                        const stats = fs.statSync(filePath);
                        if (now - stats.mtime.getTime() > maxAge) {
                            fs.unlinkSync(filePath);
                            freedBytes += stats.size;
                            cleaned++;
                        }
                    } catch {
                        // Skip
                    }
                }
            }
        } catch (error) {
            console.error('Maintenance error:', error);
        }

        return {
            cleaned,
            freedBytes: this.formatBytes(freedBytes),
            issues: []
        };
    }

    async securityScan(): Promise<SecurityResult> {
        const findings: Array<{ type: string; file: string; detail: string }> = [];

        const patterns = [
            { name: 'AWS Key', pattern: /AKIA[0-9A-Z]{16}/g },
            { name: 'API Key', pattern: /api[_-]?key['":\s]*['"]?[a-zA-Z0-9]{20,}/gi },
            { name: 'Password', pattern: /password['":\s]*['"]?[^\s'"]{8,}/gi },
            { name: 'Private Key', pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g },
            { name: 'JWT', pattern: /eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g }
        ];

        try {
            const sessions = await this.listSessions(100);

            for (const session of sessions) {
                try {
                    const content = fs.readFileSync(session.filePath, 'utf-8');

                    for (const { name, pattern } of patterns) {
                        const matches = content.match(pattern);
                        if (matches) {
                            findings.push({
                                type: name,
                                file: session.filePath,
                                detail: `Found ${matches.length} potential ${name}(s)`
                            });
                        }
                    }
                } catch {
                    // Skip unreadable files
                }
            }
        } catch (error) {
            console.error('Security scan error:', error);
        }

        return {
            issues: findings.length,
            findings
        };
    }

    async startDashboard(port = 1405): Promise<{ success: boolean; url?: string; error?: string }> {
        const url = `http://localhost:${port}`;

        if (await this.isPortAlive(port)) {
            this.log(`Dashboard already running on port ${port}; reusing ${url}`);
            return { success: true, url };
        }

        const { spawn } = await import('child_process');
        const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
        const args = ['-y', '@asifkibria/claude-code-toolkit', 'dashboard', '--port', String(port)];

        this.log(`Launching dashboard: ${command} ${args.join(' ')}`);

        return new Promise((resolve) => {
            let settled = false;
            const finish = (result: { success: boolean; url?: string; error?: string }) => {
                if (settled) return;
                settled = true;
                resolve(result);
            };

            let child: import('child_process').ChildProcess;
            try {
                child = spawn(command, args, {
                    detached: true,
                    stdio: 'ignore',
                    windowsHide: true,
                });
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                this.log(`Dashboard spawn threw: ${msg}`);
                finish({ success: false, error: msg });
                return;
            }

            child.on('error', (err: NodeJS.ErrnoException) => {
                const msg = err.code === 'ENOENT'
                    ? 'Node.js / npx was not found on your PATH. Install Node.js 18+ and reload VS Code.'
                    : err.message;
                this.log(`Dashboard error: ${msg}`);
                finish({ success: false, error: msg });
            });

            child.on('exit', (code, signal) => {
                if (code !== 0 && code !== null) {
                    this.log(`Dashboard child exited early with code ${code} (signal ${signal ?? 'none'})`);
                    finish({ success: false, error: `Dashboard process exited with code ${code}` });
                }
            });

            child.unref();

            this.waitForPort(port, 15000).then((alive) => {
                if (alive) {
                    this.log(`Dashboard is listening on ${url}`);
                    finish({ success: true, url });
                } else {
                    this.log(`Dashboard did not start listening on port ${port} within 15s`);
                    finish({ success: false, error: `Dashboard did not start on port ${port} in time` });
                }
            });
        });
    }

    private isPortAlive(port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const net = require('net') as typeof import('net');
            const socket = new net.Socket();
            const done = (alive: boolean) => {
                socket.destroy();
                resolve(alive);
            };
            socket.setTimeout(500);
            socket.once('connect', () => done(true));
            socket.once('timeout', () => done(false));
            socket.once('error', () => done(false));
            socket.connect(port, '127.0.0.1');
        });
    }

    private async waitForPort(port: number, timeoutMs: number): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (await this.isPortAlive(port)) return true;
            await new Promise((r) => setTimeout(r, 250));
        }
        return false;
    }

    private formatBytes(bytes: number): string {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    // Quick stats for status bar
    async getQuickStats(): Promise<{ sessions: number; size: string; issues: number }> {
        try {
            const sessions = await this.listSessions(100);
            const totalSize = sessions.reduce((sum, s) => sum + s.sizeBytes, 0);
            const issues = sessions.filter(s => s.health !== 'healthy').length;

            return {
                sessions: sessions.length,
                size: this.formatBytes(totalSize),
                issues
            };
        } catch {
            return { sessions: 0, size: '0 B', issues: 0 };
        }
    }
}
