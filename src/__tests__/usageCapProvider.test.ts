import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Mock vscode module completely before importing the provider
vi.mock("vscode", () => {
  const EventEmitter = class {
    event = vi.fn();
    fire = vi.fn();
    dispose = vi.fn();
  };
  const ThemeIcon = class {
    constructor(public id: string, public color?: unknown) {}
  };
  const ThemeColor = class {
    constructor(public id: string) {}
  };
  const MarkdownString = class {
    constructor(public value: string) {}
  };
  const TreeItem = class {
    label?: string;
    description?: string;
    iconPath?: unknown;
    tooltip?: unknown;
    command?: unknown;
    contextValue?: string;
    constructor(label: string, public collapsibleState: number) {
      this.label = label;
    }
  };

  return {
    EventEmitter,
    ThemeIcon,
    ThemeColor,
    MarkdownString,
    TreeItem,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    window: {
      showWarningMessage: vi.fn().mockResolvedValue(undefined),
      showInformationMessage: vi.fn().mockResolvedValue(undefined),
      showErrorMessage: vi.fn().mockResolvedValue(undefined),
      showInputBox: vi.fn().mockResolvedValue(undefined),
      showQuickPick: vi.fn().mockResolvedValue(undefined),
      terminals: [],
      createTerminal: vi.fn().mockReturnValue({
        show: vi.fn(),
        sendText: vi.fn(),
        name: "Claude Queue",
      }),
    },
  };
});

const TEST_HOME = "/tmp/cct-vscode-test";
const CONFIG_PATH = path.join(TEST_HOME, ".claude", "prompt-queue.json");

vi.mock("os", () => ({
  homedir: () => TEST_HOME,
  tmpdir: () => "/tmp",
}));

async function getProvider() {
  vi.resetModules();
  vi.doMock("os", () => ({ homedir: () => TEST_HOME }));
  const mod = await import("../providers/usageCapProvider.js");
  return mod;
}

function writeConfig(data: object) {
  const dir = path.dirname(CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data), "utf-8");
}

describe("UsageCapProvider", () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_HOME)) fs.rmSync(TEST_HOME, { recursive: true });
    fs.mkdirSync(path.join(TEST_HOME, ".claude"), { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    if (fs.existsSync(TEST_HOME)) fs.rmSync(TEST_HOME, { recursive: true });
    vi.restoreAllMocks();
  });

  describe("parseResetTime (via private access)", () => {
    it('should parse "4am" to a valid future Date', async () => {
      const { UsageCapProvider } = await getProvider();
      const provider = new UsageCapProvider();
      const result = (provider as any).parseResetTime("4am");
      expect(result).toBeInstanceOf(Date);
      expect(result.getHours()).toBe(4);
      expect(result.getMinutes()).toBe(0);
      provider.dispose();
    });

    it('should parse "3:30pm" correctly', async () => {
      const { UsageCapProvider } = await getProvider();
      const provider = new UsageCapProvider();
      const result = (provider as any).parseResetTime("3:30pm");
      expect(result).toBeInstanceOf(Date);
      expect(result.getHours()).toBe(15);
      expect(result.getMinutes()).toBe(30);
      provider.dispose();
    });

    it('should parse "12am" as midnight (hour 0)', async () => {
      const { UsageCapProvider } = await getProvider();
      const provider = new UsageCapProvider();
      const result = (provider as any).parseResetTime("12am");
      expect(result).toBeInstanceOf(Date);
      expect(result.getHours()).toBe(0);
      provider.dispose();
    });

    it('should parse "12pm" as noon (hour 12)', async () => {
      const { UsageCapProvider } = await getProvider();
      const provider = new UsageCapProvider();
      const result = (provider as any).parseResetTime("12pm");
      expect(result).toBeInstanceOf(Date);
      expect(result.getHours()).toBe(12);
      provider.dispose();
    });

    it('should parse "0:00" as midnight in 24h format', async () => {
      const { UsageCapProvider } = await getProvider();
      const provider = new UsageCapProvider();
      const result = (provider as any).parseResetTime("0:00");
      expect(result).toBeInstanceOf(Date);
      expect(result.getMinutes()).toBe(0);
      provider.dispose();
    });

    it('should parse "14:30" in 24h format', async () => {
      const { UsageCapProvider } = await getProvider();
      const provider = new UsageCapProvider();
      const result = (provider as any).parseResetTime("14:30");
      expect(result).toBeInstanceOf(Date);
      expect(result.getHours()).toBe(14);
      expect(result.getMinutes()).toBe(30);
      provider.dispose();
    });

    it("should return null for invalid string", async () => {
      const { UsageCapProvider } = await getProvider();
      const provider = new UsageCapProvider();
      const result = (provider as any).parseResetTime("not-a-time");
      expect(result).toBeNull();
      provider.dispose();
    });

    it("should return null for empty string", async () => {
      const { UsageCapProvider } = await getProvider();
      const provider = new UsageCapProvider();
      const result = (provider as any).parseResetTime("");
      expect(result).toBeNull();
      provider.dispose();
    });

    it("should return a future date when the time has already passed today", async () => {
      const { UsageCapProvider } = await getProvider();
      const provider = new UsageCapProvider();
      // Set a time that is definitely in the past (1am should already be past if test runs during the day)
      const pastHour = new Date();
      pastHour.setHours(pastHour.getHours() - 2);
      const timeStr = `${pastHour.getHours()}:${String(pastHour.getMinutes()).padStart(2, "0")}`;
      const result = (provider as any).parseResetTime(timeStr);
      if (result) {
        expect(result.getTime()).toBeGreaterThan(Date.now());
      }
      provider.dispose();
    });
  });

  describe("sendToTerminal escaping", () => {
    it("should escape backticks to prevent command substitution", async () => {
      const { UsageCapProvider } = await getProvider();
      const vscode = await import("vscode");
      const mockTerminal = { show: vi.fn(), sendText: vi.fn(), name: "Claude Queue" };
      (vscode.window.createTerminal as any).mockReturnValue(mockTerminal);
      (vscode.window.terminals as any) = [];

      const provider = new UsageCapProvider();
      await (provider as any).sendToTerminal("run `ls -la`");

      const sentText: string = mockTerminal.sendText.mock.calls[0]?.[0] ?? "";
      expect(sentText).not.toMatch(/`ls -la`/);
      expect(sentText).toContain("\\`");
      provider.dispose();
    });

    it("should escape $() to prevent command substitution", async () => {
      const { UsageCapProvider } = await getProvider();
      const vscode = await import("vscode");
      const mockTerminal = { show: vi.fn(), sendText: vi.fn(), name: "Claude Queue" };
      (vscode.window.createTerminal as any).mockReturnValue(mockTerminal);
      (vscode.window.terminals as any) = [];

      const provider = new UsageCapProvider();
      await (provider as any).sendToTerminal("do $(whoami)");

      const sentText: string = mockTerminal.sendText.mock.calls[0]?.[0] ?? "";
      // After escaping, $ becomes \$, so the terminal never sees unescaped $(whoami)
      expect(sentText).toContain("\\$");
      // The resulting command should not have an unescaped $( — it must be \$(
      expect(sentText).not.toMatch(/(?<!\\)\$\(/g);
      provider.dispose();
    });

    it("should escape double quotes", async () => {
      const { UsageCapProvider } = await getProvider();
      const vscode = await import("vscode");
      const mockTerminal = { show: vi.fn(), sendText: vi.fn(), name: "Claude Queue" };
      (vscode.window.createTerminal as any).mockReturnValue(mockTerminal);
      (vscode.window.terminals as any) = [];

      const provider = new UsageCapProvider();
      await (provider as any).sendToTerminal('He said "hello"');

      const sentText: string = mockTerminal.sendText.mock.calls[0]?.[0] ?? "";
      expect(sentText).toContain('\\"');
      provider.dispose();
    });

    it("should convert newlines to \\n for single-line terminal command", async () => {
      const { UsageCapProvider } = await getProvider();
      const vscode = await import("vscode");
      const mockTerminal = { show: vi.fn(), sendText: vi.fn(), name: "Claude Queue" };
      (vscode.window.createTerminal as any).mockReturnValue(mockTerminal);
      (vscode.window.terminals as any) = [];

      const provider = new UsageCapProvider();
      await (provider as any).sendToTerminal("line one\nline two");

      const sentText: string = mockTerminal.sendText.mock.calls[0]?.[0] ?? "";
      expect(sentText).not.toMatch(/\n(?!n)/);
      expect(sentText).toContain("\\n");
      provider.dispose();
    });
  });

  describe("Toolkit checkSessionHealth (via toolkit.ts)", () => {
    async function getToolkit() {
      vi.resetModules();
      vi.doMock("os", () => ({ homedir: () => TEST_HOME }));
      const mod = await import("../toolkit.js");
      return new mod.Toolkit();
    }

    it("should return empty when no projects directory exists", async () => {
      // Remove the .claude dir so healthCheck detects absence
      const claudeDir = path.join(TEST_HOME, ".claude");
      if (fs.existsSync(claudeDir)) fs.rmSync(claudeDir, { recursive: true });
      const toolkit = await getToolkit();
      const result = await toolkit.healthCheck();
      expect(result.healthy).toBe(false);
      expect(result.warnings).toContain("Claude directory not found (~/.claude)");
    });

    it("should report healthy with no sessions", async () => {
      fs.mkdirSync(path.join(TEST_HOME, ".claude", "projects"), { recursive: true });
      const toolkit = await getToolkit();
      const result = await toolkit.healthCheck();
      expect(result.sessionCount).toBe(0);
      expect(result.issues).toBe(0);
    });

    it("should detect corrupted session files", async () => {
      const projectDir = path.join(TEST_HOME, ".claude", "projects", "my-project");
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, "corrupted.jsonl"), "not valid json at all!!!", "utf-8");

      const toolkit = await getToolkit();
      const sessions = await toolkit.listSessions();
      const corrupt = sessions.find(s => s.health === "corrupted");
      expect(corrupt).toBeDefined();
    });

    it("should detect empty session files", async () => {
      const projectDir = path.join(TEST_HOME, ".claude", "projects", "my-project");
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, "empty-session.jsonl"), "", "utf-8");

      const toolkit = await getToolkit();
      const sessions = await toolkit.listSessions();
      const empty = sessions.find(s => s.health === "empty");
      expect(empty).toBeDefined();
    });

    it("should report healthy for valid jsonl session", async () => {
      const projectDir = path.join(TEST_HOME, ".claude", "projects", "my-project");
      fs.mkdirSync(projectDir, { recursive: true });
      const content = [
        JSON.stringify({ type: "user", message: { role: "user", content: [] } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [] } }),
      ].join("\n");
      fs.writeFileSync(path.join(projectDir, "good-session.jsonl"), content, "utf-8");

      const toolkit = await getToolkit();
      const sessions = await toolkit.listSessions();
      const healthy = sessions.find(s => s.health === "healthy");
      expect(healthy).toBeDefined();
    });

    it("should count messages in session correctly", async () => {
      const projectDir = path.join(TEST_HOME, ".claude", "projects", "my-project");
      fs.mkdirSync(projectDir, { recursive: true });
      const lines = [
        JSON.stringify({ type: "user", message: { role: "user", content: [] } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [] } }),
        JSON.stringify({ type: "user", message: { role: "user", content: [] } }),
      ];
      fs.writeFileSync(path.join(projectDir, "session.jsonl"), lines.join("\n"), "utf-8");

      const toolkit = await getToolkit();
      const sessions = await toolkit.listSessions();
      expect(sessions[0].messageCount).toBe(3);
    });
  });
});
