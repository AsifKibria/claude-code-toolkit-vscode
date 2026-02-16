import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as os from 'os';

const execFileAsync = promisify(execFile);

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
    modified: string;
    sizeBytes: number;
    messageCount: number;
    filePath: string;
    starred?: boolean;
    tags?: string[];
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

export class Toolkit {
    private claudeDir = path.join(os.homedir(), '.claude');

    async runCommand(args: string[]): Promise<string> {
        try {
            const { stdout } = await execFileAsync('npx', ['@asifkibria/claude-code-toolkit', ...args], {
                timeout: 30000
            });
            return stdout;
        } catch (error) {
            console.error('Toolkit command failed:', error);
            throw error;
        }
    }

    async healthCheck(): Promise<HealthResult> {
        try {
            const output = await this.runCommand(['health-check']);
            const lines = output.split('\n');

            let issues = 0;
            const warnings: string[] = [];

            for (const line of lines) {
                if (line.includes('⚠') || line.includes('Warning')) {
                    warnings.push(line.trim());
                    issues++;
                }
                if (line.includes('❌') || line.includes('Error')) {
                    warnings.push(line.trim());
                    issues++;
                }
            }

            const sessionsMatch = output.match(/(\d+)\s*sessions?/i);
            const sessionCount = sessionsMatch ? parseInt(sessionsMatch[1]) : 0;

            return {
                healthy: issues === 0,
                issues,
                warnings,
                diskUsage: { used: 0, total: 0 },
                sessionCount,
                lastCheck: new Date()
            };
        } catch {
            return {
                healthy: false,
                issues: 1,
                warnings: ['Failed to run health check'],
                diskUsage: { used: 0, total: 0 },
                sessionCount: 0,
                lastCheck: new Date()
            };
        }
    }

    async listSessions(limit = 20): Promise<SessionInfo[]> {
        try {
            const output = await this.runCommand(['list-sessions', '--limit', String(limit)]);
            const sessions: SessionInfo[] = [];

            const lines = output.split('\n').filter(l => l.trim());
            for (const line of lines) {
                const match = line.match(/([a-f0-9-]{36}|[a-f0-9]{8,})\s+/i);
                if (match) {
                    const id = match[1];
                    sessions.push({
                        id,
                        project: this.extractProject(line),
                        modified: this.extractDate(line),
                        sizeBytes: this.extractSize(line),
                        messageCount: 0,
                        filePath: '',
                        starred: line.includes('★') || line.includes('starred')
                    });
                }
            }

            return sessions;
        } catch {
            return [];
        }
    }

    async getStarredSessions(): Promise<SessionInfo[]> {
        try {
            const output = await this.runCommand(['starred']);
            const sessions: SessionInfo[] = [];

            const lines = output.split('\n').filter(l => l.trim());
            for (const line of lines) {
                const match = line.match(/([a-f0-9-]{36}|[a-f0-9]{8,})/i);
                if (match) {
                    sessions.push({
                        id: match[1],
                        project: this.extractProject(line),
                        modified: '',
                        sizeBytes: 0,
                        messageCount: 0,
                        filePath: '',
                        starred: true
                    });
                }
            }

            return sessions;
        } catch {
            return [];
        }
    }

    async searchConversations(query: string, limit = 50): Promise<SearchResult[]> {
        try {
            const output = await this.runCommand(['search', query, '--limit', String(limit)]);
            const results: SearchResult[] = [];

            const blocks = output.split(/\n(?=[A-Za-z])/);
            for (const block of blocks) {
                const lines = block.split('\n');
                if (lines.length >= 2) {
                    const fileMatch = lines[0].match(/([^/]+\.jsonl)/);
                    const projectMatch = lines[0].match(/projects\/([^/]+)/);

                    results.push({
                        sessionId: fileMatch?.[1]?.replace('.jsonl', '') || '',
                        file: lines[0],
                        project: projectMatch?.[1] || 'unknown',
                        role: lines[1].includes('user') ? 'user' : 'assistant',
                        preview: lines.slice(1).join(' ').slice(0, 100),
                        line: 0
                    });
                }
            }

            return results;
        } catch {
            return [];
        }
    }

    async starSession(sessionId: string): Promise<void> {
        await this.runCommand(['star', sessionId]);
    }

    async unstarSession(sessionId: string): Promise<void> {
        await this.runCommand(['star', sessionId, '--remove']);
    }

    async getSession(sessionId: string): Promise<SessionInfo | null> {
        const sessions = await this.listSessions(100);
        return sessions.find(s => s.id === sessionId || s.id.startsWith(sessionId)) || null;
    }

    async exportSession(sessionId: string, format: string, outputPath: string): Promise<{ success: boolean; error?: string }> {
        try {
            if (format === 'html') {
                await this.runCommand(['export-html', sessionId, '--output', outputPath]);
            } else {
                await this.runCommand(['export', sessionId, '--format', format, '--output', outputPath]);
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    }

    async archiveSession(sessionId: string): Promise<void> {
        await this.runCommand(['bulk-archive', '--session', sessionId]);
    }

    async deleteSession(sessionId: string): Promise<void> {
        await this.runCommand(['bulk-delete', '--session', sessionId, '--force']);
    }

    async runMaintenance(): Promise<MaintenanceResult> {
        try {
            const output = await this.runCommand(['maintenance', '--auto']);
            const cleanedMatch = output.match(/(\d+)\s*cleaned/i);
            const freedMatch = output.match(/([\d.]+\s*[KMGT]?B)\s*freed/i);

            return {
                cleaned: cleanedMatch ? parseInt(cleanedMatch[1]) : 0,
                freedBytes: freedMatch?.[1] || '0 B',
                issues: []
            };
        } catch {
            return { cleaned: 0, freedBytes: '0 B', issues: ['Maintenance failed'] };
        }
    }

    async securityScan(): Promise<SecurityResult> {
        try {
            const output = await this.runCommand(['security-scan']);
            const issueMatch = output.match(/(\d+)\s*(?:issue|finding|secret)/i);

            return {
                issues: issueMatch ? parseInt(issueMatch[1]) : 0,
                findings: []
            };
        } catch {
            return { issues: 0, findings: [] };
        }
    }

    async startDashboard(): Promise<{ success: boolean; url?: string }> {
        try {
            const child = spawn('npx', ['@asifkibria/claude-code-toolkit', 'dashboard'], {
                detached: true,
                stdio: 'ignore'
            });
            child.unref();
            await new Promise(resolve => setTimeout(resolve, 2000));
            return { success: true, url: 'http://localhost:1405' };
        } catch {
            return { success: false };
        }
    }

    private extractProject(line: string): string {
        const match = line.match(/projects\/([^/\s]+)/i) || line.match(/\[([^\]]+)\]/);
        return match?.[1] || 'unknown';
    }

    private extractDate(line: string): string {
        const match = line.match(/(\d{4}-\d{2}-\d{2}|\d+\s*(?:min|hour|day|week)s?\s*ago)/i);
        return match?.[1] || '';
    }

    private extractSize(line: string): number {
        const match = line.match(/([\d.]+)\s*(B|KB|MB|GB)/i);
        if (!match) return 0;
        const value = parseFloat(match[1]);
        const unit = match[2].toUpperCase();
        const multipliers: Record<string, number> = { B: 1, KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024 };
        return value * (multipliers[unit] || 1);
    }
}
