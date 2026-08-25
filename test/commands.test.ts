import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { createAppContext, type AppContext } from "../src/app/context.js";
import { type AgentRuntimeEvent } from "../src/agent/events.js";
import {
  executeSlashCommand,
  formatKnowledgeStatus,
  getSlashCommandSuggestions,
  parseSlashCommand,
} from "../src/agent/commands.js";
import { MutableRuntimeSteeringBuffer, TopchesterAgentRuntime } from "../src/agent/runtime/index.js";
import { createSession, listChildSessions, loadSession } from "../src/session/store.js";
import { createSkillsService } from "../src/skills/index.js";

describe("slash commands", () => {
  it("parses slash commands and arguments", () => {
    expect(parseSlashCommand("/kb status")).toEqual({ name: "kb", args: ["status"] });
    expect(parseSlashCommand(" /kb   status  ")).toEqual({ name: "kb", args: ["status"] });
    expect(parseSlashCommand("kb status")).toBeUndefined();
    expect(parseSlashCommand("/")).toBeUndefined();
  });

  it("reports unknown commands", async () => {
    await expect(executeSlashCommand("/nope", { workspaceRoot: "/repo" })).resolves.toEqual({
      messages: ["Unknown command: /nope", "Try /kb status, /new, /fork, or /restore."],
    });
  });

  it("suggests slash commands by typed prefix", () => {
    expect(getSlashCommandSuggestions("/")).toEqual([
      {
        value: "/model",
        description: "choose from configured model choices",
      },
      {
        value: "/model all",
        description: "browse OpenRouter models",
      },
      {
        value: "/kb-model",
        description: "choose a model for KB summaries",
      },
      {
        value: "/kb-model clear",
        description: "use the configured KB model",
      },
      {
        value: "/connect",
        description: "connect a model provider",
      },
      {
        value: "/effort",
        description: "show or set reasoning effort (none, minimal, low, medium, high, xhigh, max, clear)",
      },
      {
        value: "/reasoning",
        description: "show or set reasoning effort (none, minimal, low, medium, high, xhigh, max, clear)",
      },
      {
        value: "/kb status",
        description: "show non-clean knowledge files",
      },
      {
        value: "/kb sync",
        description: "process non-clean project files into L1 entries",
      },
      {
        value: "/kb sync --full",
        description: "process all project files into L1 entries",
      },
      {
        value: "/kb live status",
        description: "show whether live L1 sync is on",
      },
      {
        value: "/kb live on",
        description: "turn on live L1 sync globally",
      },
      {
        value: "/kb live off",
        description: "turn off live L1 sync globally",
      },
      {
        value: "/kb init",
        description: "start project knowledge base setup",
      },
      {
        value: "/kb reset",
        description: "delete the local knowledge base and cache",
      },
      {
        value: "/skills",
        description: "open skills",
      },
      {
        value: "/skills list",
        description: "list available skills",
      },
      {
        value: "/skills inspect",
        description: "show one skill without activating it",
      },
      {
        value: "/skills reload",
        description: "reload skill discovery",
      },
      {
        value: "/skill",
        description: "activate a skill",
      },
      {
        value: "/queue",
        description: "queue a follow-up prompt",
      },
      {
        value: "/q",
        description: "queue a follow-up prompt",
      },
      {
        value: "/steer",
        description: "steer the active turn",
      },
      {
        value: "/new",
        description: "start a fresh session",
      },
      {
        value: "/fork",
        description: "fork the current session",
      },
      {
        value: "/restore",
        description: "restore a previous session",
      },
    ]);
    expect(getSlashCommandSuggestions("/m")).toEqual([
      {
        value: "/model",
        description: "choose from configured model choices",
      },
      {
        value: "/model all",
        description: "browse OpenRouter models",
      },
    ]);
    expect(getSlashCommandSuggestions("/c")).toEqual([
      {
        value: "/connect",
        description: "connect a model provider",
      },
    ]);
    expect(getSlashCommandSuggestions("/e")).toEqual([
      {
        value: "/effort",
        description: "show or set reasoning effort (none, minimal, low, medium, high, xhigh, max, clear)",
      },
    ]);
    expect(getSlashCommandSuggestions("/r")).toEqual([
      {
        value: "/reasoning",
        description: "show or set reasoning effort (none, minimal, low, medium, high, xhigh, max, clear)",
      },
      {
        value: "/restore",
        description: "restore a previous session",
      },
    ]);
    expect(getSlashCommandSuggestions("/k")).toEqual([
      {
        value: "/kb-model",
        description: "choose a model for KB summaries",
      },
      {
        value: "/kb-model clear",
        description: "use the configured KB model",
      },
      {
        value: "/kb status",
        description: "show non-clean knowledge files",
      },
      {
        value: "/kb sync",
        description: "process non-clean project files into L1 entries",
      },
      {
        value: "/kb sync --full",
        description: "process all project files into L1 entries",
      },
      {
        value: "/kb live status",
        description: "show whether live L1 sync is on",
      },
      {
        value: "/kb live on",
        description: "turn on live L1 sync globally",
      },
      {
        value: "/kb live off",
        description: "turn off live L1 sync globally",
      },
      {
        value: "/kb init",
        description: "start project knowledge base setup",
      },
      {
        value: "/kb reset",
        description: "delete the local knowledge base and cache",
      },
    ]);
    expect(getSlashCommandSuggestions("/kb i")).toEqual([
      {
        value: "/kb init",
        description: "start project knowledge base setup",
      },
    ]);
    expect(getSlashCommandSuggestions("/kb r")).toEqual([
      {
        value: "/kb reset",
        description: "delete the local knowledge base and cache",
      },
    ]);
    expect(getSlashCommandSuggestions("/n")).toEqual([
      {
        value: "/new",
        description: "start a fresh session",
      },
    ]);
    expect(getSlashCommandSuggestions("/f")).toEqual([
      {
        value: "/fork",
        description: "fork the current session",
      },
    ]);
    expect(getSlashCommandSuggestions("/q")).toEqual([
      {
        value: "/queue",
        description: "queue a follow-up prompt",
      },
      {
        value: "/q",
        description: "queue a follow-up prompt",
      },
    ]);
    expect(getSlashCommandSuggestions("/skill")).toEqual([
      {
        value: "/skills",
        description: "open skills",
      },
      {
        value: "/skills list",
        description: "list available skills",
      },
      {
        value: "/skills inspect",
        description: "show one skill without activating it",
      },
      {
        value: "/skills reload",
        description: "reload skill discovery",
      },
      {
        value: "/skill",
        description: "activate a skill",
      },
    ]);
    expect(getSlashCommandSuggestions("/st")).toEqual([
      {
        value: "/steer",
        description: "steer the active turn",
      },
    ]);
    expect(getSlashCommandSuggestions("/kb s")).toEqual([
      {
        value: "/kb status",
        description: "show non-clean knowledge files",
      },
      {
        value: "/kb sync",
        description: "process non-clean project files into L1 entries",
      },
      {
        value: "/kb sync --full",
        description: "process all project files into L1 entries",
      },
    ]);
    expect(getSlashCommandSuggestions("/effort ")).toEqual([
      {
        value: "/effort none",
        description: "set reasoning effort to none",
      },
      {
        value: "/effort minimal",
        description: "set reasoning effort to minimal",
      },
      {
        value: "/effort low",
        description: "set reasoning effort to low",
      },
      {
        value: "/effort medium",
        description: "set reasoning effort to medium",
      },
      {
        value: "/effort high",
        description: "set reasoning effort to high",
      },
      {
        value: "/effort xhigh",
        description: "set reasoning effort to xhigh",
      },
      {
        value: "/effort max",
        description: "set reasoning effort to max",
      },
      {
        value: "/effort clear",
        description: "use provider default reasoning effort",
      },
      {
        value: "/effort default",
        description: "use provider default reasoning effort",
      },
    ]);
    expect(getSlashCommandSuggestions("/effort l")).toEqual([
      {
        value: "/effort low",
        description: "set reasoning effort to low",
      },
    ]);
    expect(getSlashCommandSuggestions("/reasoning ")).toEqual([
      {
        value: "/reasoning none",
        description: "set reasoning effort to none",
      },
      {
        value: "/reasoning minimal",
        description: "set reasoning effort to minimal",
      },
      {
        value: "/reasoning low",
        description: "set reasoning effort to low",
      },
      {
        value: "/reasoning medium",
        description: "set reasoning effort to medium",
      },
      {
        value: "/reasoning high",
        description: "set reasoning effort to high",
      },
      {
        value: "/reasoning xhigh",
        description: "set reasoning effort to xhigh",
      },
      {
        value: "/reasoning max",
        description: "set reasoning effort to max",
      },
      {
        value: "/reasoning clear",
        description: "use provider default reasoning effort",
      },
      {
        value: "/reasoning default",
        description: "use provider default reasoning effort",
      },
    ]);
    expect(getSlashCommandSuggestions("/nope")).toEqual([]);
    expect(getSlashCommandSuggestions("hello")).toEqual([]);
  });

  it("reports that /new is an interactive TUI command outside the TUI", async () => {
    await expect(executeSlashCommand("/new", { workspaceRoot: "/repo" })).resolves.toEqual({
      messages: ["/new starts a fresh session in the interactive TUI."],
    });
  });

  it("reports that /fork is an interactive TUI command outside the TUI", async () => {
    await expect(executeSlashCommand("/fork", { workspaceRoot: "/repo" })).resolves.toEqual({
      messages: ["/fork clones the current session in the interactive TUI."],
    });
  });

  it("reports that /restore is an interactive TUI command outside the TUI", async () => {
    await expect(executeSlashCommand("/restore", { workspaceRoot: "/repo" })).resolves.toEqual({
      messages: ["/restore opens a previous-session picker in the interactive TUI."],
    });
  });

  it("reports that model and connect commands are interactive TUI commands outside the TUI", async () => {
    await expect(executeSlashCommand("/model", { workspaceRoot: "/repo" })).resolves.toEqual({
      messages: ["/model is available in the interactive TUI."],
    });
    await expect(executeSlashCommand("/connect", { workspaceRoot: "/repo" })).resolves.toEqual({
      messages: ["/connect is available in the interactive TUI."],
    });
    await expect(executeSlashCommand("/effort high", { workspaceRoot: "/repo" })).resolves.toEqual({
      messages: ["/effort is available in the interactive TUI."],
    });
    await expect(executeSlashCommand("/reasoning medium", { workspaceRoot: "/repo" })).resolves.toEqual({
      messages: ["/reasoning is available in the interactive TUI."],
    });
  });

  it("reports that /queue commands are interactive TUI commands outside the TUI", async () => {
    await expect(executeSlashCommand("/queue later", { workspaceRoot: "/repo" })).resolves.toEqual({
      messages: ["/queue is available in the interactive TUI."],
    });
    await expect(executeSlashCommand("/q later", { workspaceRoot: "/repo" })).resolves.toEqual({
      messages: ["/q is available in the interactive TUI."],
    });
  });

  it("reports that /steer is an interactive TUI command outside the TUI", async () => {
    await expect(executeSlashCommand("/steer focus on tests", { workspaceRoot: "/repo" })).resolves.toEqual({
      messages: ["/steer is available in the interactive TUI."],
    });
  });

  it("lists, inspects, reloads, and activates skills", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-skills-"));
    await mkdir(join(workspace, ".agents", "skills", "review"), { recursive: true });
    await writeFile(
      join(workspace, ".agents", "skills", "review", "SKILL.md"),
      ["---", "name: review", "description: Review changes.", "---", "", "# Review", ""].join("\n")
    );
    const skillsService = createSkillsService({
      workspaceRoot: workspace,
      homeDir: join(workspace, "home"),
      packageRoot: workspace,
    });

    await expect(executeSlashCommand("/skills", { workspaceRoot: workspace, skillsService })).resolves.toEqual({
      messages: ["Skills overlay is available in the interactive TUI.", "Run /skills list to print skills."],
    });
    await expect(executeSlashCommand("/skills list", { workspaceRoot: workspace, skillsService })).resolves.toEqual({
      messages: ["review                   workspace-neutral", "  Review changes."],
    });
    await expect(
      executeSlashCommand("/skills inspect review", { workspaceRoot: workspace, skillsService })
    ).resolves.toMatchObject({
      messages: [expect.stringContaining("# Review")],
    });
    await expect(executeSlashCommand("/skills reload", { workspaceRoot: workspace, skillsService })).resolves.toEqual({
      messages: ["Skills reloaded.\nactive: 1\nshadowed: 0"],
    });

    const activation = await executeSlashCommand("/skill review check this", {
      workspaceRoot: workspace,
      skillsService,
    });
    expect(activation.messages[0]).toBe("Skill activated: review");
    expect(activation.messages[1]).toContain("[Skill: review]");
    expect(activation.messages[1]).toContain("User instruction:\ncheck this");
    expect(activation.skillActivation).toMatchObject({
      skill: { name: "review" },
      instruction: "check this",
    });

    await expect(
      executeSlashCommand("/review check shortcut", { workspaceRoot: workspace, skillsService })
    ).resolves.toMatchObject({
      skillActivation: {
        skill: { name: "review" },
        instruction: "check shortcut",
      },
    });
  });

  it("colors skill names and sources in TUI-capable skill lists", async () => {
    const previousForceColor = process.env.FORCE_COLOR;
    const previousNoColor = process.env.NO_COLOR;
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-skills-"));
    await mkdir(join(workspace, ".agents", "skills", "review"), { recursive: true });
    await writeFile(
      join(workspace, ".agents", "skills", "review", "SKILL.md"),
      ["---", "name: review", "description: Review changes.", "---", "", "# Review", ""].join("\n")
    );
    const skillsService = createSkillsService({
      workspaceRoot: workspace,
      homeDir: join(workspace, "home"),
      packageRoot: workspace,
    });
    process.env.FORCE_COLOR = "1";
    delete process.env.NO_COLOR;

    try {
      const result = await executeSlashCommand("/skills list", { workspaceRoot: workspace, skillsService });

      expect(result.messages[0]).toContain("\u001b[34mreview");
      expect(result.messages[0]).toContain("\u001b[90mworkspace-neutral\u001b[0m");
      expect(result.messages[1]).toBe("  Review changes.");
    } finally {
      if (previousForceColor === undefined) {
        delete process.env.FORCE_COLOR;
      } else {
        process.env.FORCE_COLOR = previousForceColor;
      }
      if (previousNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = previousNoColor;
      }
    }
  });

  it("reports /kb usage for unknown KB subcommands", async () => {
    await expect(executeSlashCommand("/kb nope", { workspaceRoot: "/repo" })).resolves.toEqual({
      messages: ["Usage: /kb init, /kb sync [--full] [paths...], /kb live on|off|status, /kb reset, or /kb status"],
    });
  });

  it("persists /kb live globally and reports KB availability", async () => {
    const previousHome = process.env.HOME;
    const root = await mkdtemp(join(tmpdir(), "topchester-commands-live-"));
    const workspace = join(root, "workspace");
    process.env.HOME = join(root, "home");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "topchester.jsonc"), '{ "knowledge": { "live": false } }\n');

    try {
      const result = await executeSlashCommand("/kb live on", { workspaceRoot: workspace });
      expect(result.messages).toEqual([
        "KB live",
        "state: on",
        "config: ~/.config/topchester/config.jsonc",
        "knowledge folder: not initialized",
      ]);
      expect(await readFile(join(process.env.HOME, ".config", "topchester", "config.jsonc"), "utf8")).toContain(
        '"live": true'
      );
      expect(await readFile(join(workspace, "topchester.jsonc"), "utf8")).toBe('{ "knowledge": { "live": false } }\n');
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it("reloads the running runtime config after /kb live changes", async () => {
    const previousHome = process.env.HOME;
    const previousLogLevel = process.env.TOPCHESTER_LOG_LEVEL;
    const root = await mkdtemp(join(tmpdir(), "topchester-runtime-live-"));
    const workspace = join(root, "workspace");
    process.env.HOME = join(root, "home");
    process.env.TOPCHESTER_LOG_LEVEL = "silent";
    await mkdir(workspace, { recursive: true });

    try {
      const context = createAppContext({ workspaceRoot: workspace });
      const runtime = new TopchesterAgentRuntime(context);
      expect(context.config.knowledge?.live).toBeUndefined();
      await runtime.submitSlashCommand("/kb live on");
      expect(context.config.knowledge?.live).toBe(true);
      await runtime.submitSlashCommand("/kb live off");
      expect(context.config.knowledge?.live).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousLogLevel === undefined) delete process.env.TOPCHESTER_LOG_LEVEL;
      else process.env.TOPCHESTER_LOG_LEVEL = previousLogLevel;
    }
  });

  it("executes /kb init and creates project folders", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));

    const result = await executeSlashCommand("/kb init", { workspaceRoot: workspace });

    expect(result.messages).toContain("KB init");
    expect(result.messages).toContain(`workspace: ${workspace}`);
    expect(result.messages).toContain(`created: ${join(workspace, ".agents/topchester")}`);
    expect(result.messages).toContain(`created: ${join(workspace, ".agents/topchester/sessions")}`);
    expect(result.messages).toContain(`created: ${join(workspace, ".agents/topchester/logs")}`);
    expect(result.messages).toContain(`created: ${join(workspace, "topchester-kb")}`);
    expect(result.messages).toContain(`created: ${join(workspace, "topchester-kb/l1-files")}`);
    expect(result.messages).toContain(`created: ${join(workspace, ".agents/topchester-kb-cache")}`);
    await expect(stat(join(workspace, ".agents/topchester"))).resolves.toMatchObject({});
  });

  it("executes /kb reset and removes knowledge folders", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    const kbPath = join(workspace, "topchester-kb");
    const cachePath = join(workspace, ".agents/topchester-kb-cache");
    await mkdir(kbPath, { recursive: true });
    await mkdir(cachePath, { recursive: true });
    await writeFile(join(kbPath, "manifest.json"), "{}\n");
    await writeFile(join(cachePath, "l1-queue.json"), "[]\n");

    const result = await executeSlashCommand("/kb reset", { workspaceRoot: workspace });

    expect(result.messages).toContain("KB reset");
    expect(result.messages).toContain(`removed: ${kbPath}`);
    expect(result.messages).toContain(`removed: ${cachePath}`);
    expect(result.messages).toContain("state: project knowledge base was reset");
    await expect(stat(kbPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(cachePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("executes /kb sync --full through the model-backed L1 pipeline", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await executeSlashCommand("/kb init", { workspaceRoot: workspace });
    await writeFile(join(workspace, "src", "index.ts"), "export const value = 1;\n");

    const result = await executeSlashCommand("/kb sync --full", {
      workspaceRoot: workspace,
      modelGateway: {
        async generateText() {
          return {
            text: JSON.stringify({
              language: "typescript",
              summary: "Describes the entry file.",
              responsibilities: ["Export a test value."],
              symbols: [],
              imports: [],
              exports: ["value"],
              module_ids: [],
              feature_ids: [],
              test_ids: [],
              evidence: [{ kind: "path", value: "src/index.ts" }],
              confidence: "medium",
            }),
            providerId: "fake",
            modelId: "fake-l1",
            purpose: "kb.summarize" as const,
          };
        },
      },
    });

    expect(result.messages).toContain("KB sync --full");
    expect(result.messages).toContain("queued: 1");
    expect(result.messages).toContain("completed: 1");
    expect(result.messages).toContain("state: L1 entries are ready and current");
  });

  it("executes /kb sync through the dirty-file L1 pipeline", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await executeSlashCommand("/kb init", { workspaceRoot: workspace });
    await writeFile(join(workspace, "src", "index.ts"), "export const value = 1;\n");

    const result = await executeSlashCommand("/kb sync", {
      workspaceRoot: workspace,
      modelGateway: {
        async generateText() {
          return {
            text: JSON.stringify({
              language: "typescript",
              summary: "Syncs the entry file.",
              responsibilities: ["Export a test value."],
              symbols: [],
              imports: [],
              exports: ["value"],
              module_ids: [],
              feature_ids: [],
              test_ids: [],
              evidence: [{ kind: "path", value: "src/index.ts" }],
              confidence: "medium",
            }),
            providerId: "fake",
            modelId: "fake-l1",
            purpose: "kb.summarize" as const,
          };
        },
      },
    });

    expect(result.messages).toContain("KB sync");
    expect(result.messages).toContain("queued: 1");
    expect(result.messages).toContain("completed: 1");
    expect(result.messages).toContain("state: L1 entries are ready and current");
  });

  it("syncs named files without inventorying the rest of the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-file-sync-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await executeSlashCommand("/kb init", { workspaceRoot: workspace });
    await writeFile(join(workspace, "src", "first.ts"), "export const first = 1;\n");
    await writeFile(join(workspace, "src", "other.ts"), "export const other = 2;\n");
    let calls = 0;
    const modelGateway = {
      async generateText() {
        calls += 1;
        return {
          text: JSON.stringify({
            language: "typescript",
            summary: "Exports a fixture value.",
            responsibilities: ["Export a fixture value."],
            symbols: [],
            imports: [],
            exports: ["first"],
            module_ids: [],
            feature_ids: [],
            test_ids: [],
            evidence: [{ kind: "path", value: "src/first.ts" }],
            confidence: "medium",
          }),
          providerId: "fake",
          modelId: "fake-l1",
          purpose: "kb.summarize" as const,
        };
      },
    };

    const first = await executeSlashCommand("/kb sync src/first.ts", { workspaceRoot: workspace, modelGateway });
    const current = await executeSlashCommand("/kb sync src/first.ts", { workspaceRoot: workspace, modelGateway });

    expect(first.messages).toContain("src/first.ts");
    expect(first.messages).toContain("status: completed");
    expect(current.messages).toContain("status: skipped_current");
    expect(calls).toBe(1);
    await expect(stat(join(workspace, "topchester-kb", "l1-files", "src", "other.ts.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects paths combined with /kb sync --full", async () => {
    await expect(executeSlashCommand("/kb sync --full src/index.ts", { workspaceRoot: "/repo" })).resolves.toEqual({
      messages: ["Usage: /kb sync [--full] [paths...]"],
    });
  });

  it("propagates cancellation through /kb sync instead of reporting a file failure", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-cancel-"));
    const abortController = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    await mkdir(join(workspace, "src"), { recursive: true });
    await executeSlashCommand("/kb init", { workspaceRoot: workspace });
    await writeFile(join(workspace, "src", "index.ts"), "export const value = 1;\n");

    const sync = executeSlashCommand("/kb sync", {
      workspaceRoot: workspace,
      abortSignal: abortController.signal,
      modelGateway: {
        async generateText(request) {
          receivedSignal = request.abortSignal;
          await new Promise<void>((_resolve, reject) =>
            request.abortSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
              once: true,
            })
          );
          throw new Error("unreachable");
        },
      },
    });

    await expect.poll(() => receivedSignal).toBe(abortController.signal);
    abortController.abort();

    await expect(sync).rejects.toMatchObject({ name: "AbortError" });
  });

  it("surfaces /kb sync setup and model failures as chat messages", async () => {
    await expect(executeSlashCommand("/kb sync", { workspaceRoot: "/repo" })).resolves.toEqual({
      messages: ["KB sync failed: Run `topchester kb init` before syncing the project knowledge base."],
    });

    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await executeSlashCommand("/kb init", { workspaceRoot: workspace });
    await writeFile(join(workspace, "src", "index.ts"), "export const value = 1;\n");

    await expect(executeSlashCommand("/kb sync", { workspaceRoot: workspace })).resolves.toEqual({
      messages: ['KB sync failed: No model configured for purpose "kb.summarize"; L1 entries were not processed.'],
    });
  });

  it("formats missing KB status", () => {
    expect(
      formatKnowledgeStatus({
        workspaceRoot: "/repo",
        kbPath: "/repo/topchester-kb",
        cachePath: "/repo/.agents/topchester-kb-cache",
        kbExists: false,
        kbIsDirectory: false,
        cacheExists: false,
        cacheIsDirectory: false,
        kbPathSource: "default",
        cachePathSource: "default",
      })
    ).toEqual([
      "KB status",
      "workspace: /repo",
      "knowledge folder: /repo/topchester-kb [missing] (default)",
      "local cache folder: /repo/.agents/topchester-kb-cache [missing] (default)",
      "state: no knowledge base found yet",
    ]);
  });

  it("formats empty KB status", () => {
    expect(
      formatKnowledgeStatus({
        workspaceRoot: "/repo",
        kbPath: "/repo/topchester-kb",
        cachePath: "/repo/.agents/topchester-kb-cache",
        kbExists: true,
        kbIsDirectory: true,
        cacheExists: false,
        cacheIsDirectory: false,
        kbContentState: "empty",
        kbPathSource: "default",
        cachePathSource: "default",
      })
    ).toEqual([
      "KB status",
      "workspace: /repo",
      "knowledge folder: /repo/topchester-kb [empty] (default)",
      "local cache folder: /repo/.agents/topchester-kb-cache [missing] (default)",
      "state: knowledge base folder is empty",
    ]);
  });

  it("executes /kb status against the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "index.ts"), "export const value = 1;\n");

    const result = await executeSlashCommand("/kb status", { workspaceRoot: workspace });

    expect(result.messages).toContain("KB status");
    expect(result.messages).toContain(`workspace: ${workspace}`);
    expect(result.messages).toContain(`knowledge folder: ${join(workspace, "topchester-kb")} [missing]`);
    expect(result.messages).toContain("non-clean files: 1");
    expect(result.messages).toContain("");
    expect(result.messages).toContain("status             size  path");
    expect(result.messages.some((line) => /^missing_entry {2,}\d+ bytes {2}src\/index\.ts$/u.test(line))).toBe(true);
    expect(result.messages).toContain("----");
    expect(result.messages).toContain("total non-clean files: 1");
  });

  it("refreshes runtime KB status after KB slash commands", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    const runtime = new TopchesterAgentRuntime(createTestContext(workspace));

    await expect(getRuntimeKnowledgeFolderState(runtime, "/kb status")).resolves.toEqual({
      exists: false,
      isDirectory: false,
    });
    await expect(getRuntimeKnowledgeFolderState(runtime, "/kb init")).resolves.toEqual({
      exists: true,
      isDirectory: true,
    });
    await expect(getRuntimeKnowledgeFolderState(runtime, "/kb sync")).resolves.toEqual({
      exists: true,
      isDirectory: true,
    });
    await expect(getRuntimeKnowledgeFolderState(runtime, "/kb reset")).resolves.toEqual({
      exists: false,
      isDirectory: false,
    });
  });

  it("adds non-clean file count to startup KB status", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await mkdir(join(workspace, "topchester-kb"), { recursive: true });
    await writeFile(join(workspace, "src", "index.ts"), "export const value = 1;\n");
    await writeFile(
      join(workspace, "topchester-kb", "manifest.json"),
      JSON.stringify({ l1: { completed: 0, currentEntries: 1 } }, null, 2)
    );
    const runtime = new TopchesterAgentRuntime(createTestContext(workspace));

    const events = await runtime.checkKnowledgeBase();
    const event = events.find((candidate) => candidate.type === "knowledge_status");

    expect(event?.type === "knowledge_status" ? event.status.nonCleanFileCount : undefined).toBe(1);
  });

  it("adds startup guidance when KB files are not current", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await mkdir(join(workspace, "topchester-kb"), { recursive: true });
    await writeFile(join(workspace, "src", "index.ts"), "export const value = 1;\n");
    await writeFile(
      join(workspace, "topchester-kb", "manifest.json"),
      JSON.stringify({ l1: { completed: 0, currentEntries: 1 } }, null, 2)
    );
    const runtime = new TopchesterAgentRuntime(createTestContext(workspace));

    const events = await runtime.checkKnowledgeBase();
    const event = getKnowledgeStatusEvent(events);

    expect(event?.guidance).toBe("Next: run /kb sync to update project knowledge, or /kb status to inspect the files.");
  });

  it("refreshes non-clean file count after /kb sync", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "index.ts"), "export const value = 1;\n");
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: fakeKbModel(),
    });

    await runtime.submitSlashCommand("/kb init");
    await runtime.submitSlashCommand("/kb sync");
    await writeFile(join(workspace, "src", "index.ts"), "export const value = 2;\n");

    const dirtyEvents = await runtime.submitSlashCommand("/kb status");
    const syncEvents = await runtime.submitSlashCommand("/kb sync");

    expect(getKnowledgeStatusEvent(dirtyEvents)?.status.nonCleanFileCount).toBe(1);
    expect(getKnowledgeStatusEvent(syncEvents)?.status.nonCleanFileCount).toBe(0);
  });

  it("formats edit_file tool calls and results for the final model prompt", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    await writeFile(join(workspace, "example.txt"), "enabled=false\n");
    const prompts: string[] = [];
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateText(request: { prompt: string }) {
          prompts.push(request.prompt);

          return prompts.length === 1
            ? {
                text: JSON.stringify({
                  tool: "edit_file",
                  args: {
                    path: "example.txt",
                    edits: [{ old_text: "enabled=false\n", new_text: "enabled=true\n" }],
                  },
                }),
                providerId: "fake",
                modelId: "fake-agent",
                purpose: "agent.primary" as const,
              }
            : {
                text: "Updated example.txt.",
                providerId: "fake",
                modelId: "fake-agent",
                purpose: "agent.primary" as const,
              };
        },
      } as unknown as AppContext["modelGateway"],
    });

    const events = await runtime.submitMessage([], "turn it on");

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool_call", label: "edit_file: example.txt (changed +1/-1)" }),
        expect.objectContaining({ type: "message", role: "assistant", text: "Updated example.txt." }),
      ])
    );
    expect(prompts[1]).toContain('Tool result from edit_file "example.txt":');
    expect(prompts[1]).toContain("after_hash: sha256:");
    expect(prompts[1]).toContain("kb_state: needs_sync");
    expect(prompts[1]).toContain("first_changed_line: 1");
    expect(prompts[1]).toContain("```diff");
    expect(prompts[1]).toContain("-enabled=false");
    expect(prompts[1]).toContain("+enabled=true");
    expect(prompts[1]).not.toContain("Edited example.txt");
  });

  it("injects runtime steering into the next prompt after a tool result", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-runtime-steering-"));
    await writeFile(join(workspace, "notes.txt"), "hello\n");
    const prompts: string[] = [];
    const steering = new MutableRuntimeSteeringBuffer();
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateText(request: { prompt: string }) {
          prompts.push(request.prompt);

          if (prompts.length === 1) {
            steering.push("Prefer a concise answer.");
            return {
              text: JSON.stringify({ tool: "read_file", args: { path: "notes.txt" } }),
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
            };
          }

          return {
            text: "Read notes concisely.",
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    const events = await runtime.submitMessage([], "read notes", undefined, undefined, { steering });

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool_call", label: "read_file: notes.txt" }),
        expect.objectContaining({ type: "message", role: "assistant", text: "Read notes concisely." }),
      ])
    );
    expect(prompts[0]).not.toContain("User steering received while this turn was running:");
    expect(prompts[1]).toContain('Tool result from read_file "notes.txt":');
    expect(prompts[1]).toContain("User steering received while this turn was running:");
    expect(prompts[1]).toContain("Prefer a concise answer.");
    expect(prompts[1]).toContain(
      "Continue the user's original request, applying this steering if it is still relevant."
    );
    expect(steering.hasPending()).toBe(false);
  });

  it("shows cumulative model token usage in assistant metadata when enabled", async () => {
    const previous = process.env.TOPCHESTER_SHOW_TOKEN_USAGE;
    process.env.TOPCHESTER_SHOW_TOKEN_USAGE = "1";

    try {
      const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
      await writeFile(join(workspace, "notes.txt"), "hello\n");
      let calls = 0;
      const runtime = new TopchesterAgentRuntime({
        ...createTestContext(workspace),
        modelGateway: {
          async generateText() {
            calls += 1;

            return calls === 1
              ? {
                  text: JSON.stringify({ tool: "read_file", args: { path: "notes.txt" } }),
                  providerId: "fake",
                  modelId: "fake-agent",
                  purpose: "agent.primary" as const,
                  usage: {
                    inputTokens: 1_200,
                    outputTokens: 30,
                    totalTokens: 1_230,
                    cacheReadTokens: 1_000,
                    costUsd: 0.00014,
                  },
                }
              : {
                  text: "Read notes.txt.",
                  providerId: "fake",
                  modelId: "fake-agent",
                  purpose: "agent.primary" as const,
                  usage: {
                    inputTokens: 345,
                    outputTokens: 67,
                    totalTokens: 412,
                    cacheReadTokens: 234,
                    cacheWriteTokens: 20,
                    costUsd: 0.00042,
                  },
                };
          },
        } as unknown as AppContext["modelGateway"],
      });

      const events = await runtime.submitMessage([], "read notes");
      const assistantMessage = events.find((event) => event.type === "message" && event.role === "assistant");

      expect(assistantMessage).toEqual(
        expect.objectContaining({
          meta: expect.stringMatching(
            /fake-agent · .* · 1,545 input \/ 97 output tokens \/ 1,234 cache read \/ 20 cache write \/ \$0.00056/u
          ),
        })
      );
    } finally {
      if (previous === undefined) {
        delete process.env.TOPCHESTER_SHOW_TOKEN_USAGE;
      } else {
        process.env.TOPCHESTER_SHOW_TOKEN_USAGE = previous;
      }
    }
  });

  it("passes transient reasoning callbacks through the runtime without emitting durable events", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    const reasoningEvents: string[] = [];
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateAgentStep(request: { onReasoning?: (event: { type: "delta"; text: string }) => void }) {
          request.onReasoning?.({ type: "delta", text: "checking local context" });

          return {
            text: "Done.",
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
            toolCalls: [],
            toolProtocol: "text-json" as const,
            protocolAttempts: [],
            providerRejectedTools: false,
            warnings: [],
            openRouterRoutingApplied: false,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    const events = await runtime.submitMessage([], "think out loud", undefined, undefined, {
      onReasoning(event) {
        reasoningEvents.push(`${event.type}:${event.text}`);
      },
    });

    expect(reasoningEvents).toEqual(["delta:checking local context"]);
    expect(events).toEqual([
      expect.objectContaining({ type: "message", role: "assistant", text: "Done." }),
      { type: "status", status: "ready" },
    ]);
    expect(JSON.stringify(events)).not.toContain("checking local context");
  });

  it("collects submitMessage results from the runtime stream path", async () => {
    function runtimeWithFinalMessage(workspace: string): TopchesterAgentRuntime {
      return new TopchesterAgentRuntime({
        ...createTestContext(workspace),
        modelGateway: {
          async generateAgentStep() {
            return {
              text: "Done.",
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
              toolCalls: [],
              toolProtocol: "text-json" as const,
              protocolAttempts: [],
              providerRejectedTools: false,
              warnings: [],
              openRouterRoutingApplied: false,
            };
          },
        } as unknown as AppContext["modelGateway"],
      });
    }

    const streamWorkspace = await mkdtemp(join(tmpdir(), "topchester-stream-runtime-"));
    const collectorWorkspace = await mkdtemp(join(tmpdir(), "topchester-stream-runtime-"));
    const streamed = await collectRuntimeEvents(
      runtimeWithFinalMessage(streamWorkspace).submitMessageStream([], "hello")
    );
    const collected = await runtimeWithFinalMessage(collectorWorkspace).submitMessage([], "hello");

    expect(normalizeRuntimeEventsForComparison(collected)).toEqual(normalizeRuntimeEventsForComparison(streamed));
  });

  it("runs task tool calls as child sessions and feeds the bounded result back to the parent", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-task-tool-"));
    const session = await createSession(workspace);
    const prompts: string[] = [];
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateAgentStep(request: { prompt: string }) {
          prompts.push(request.prompt);

          if (request.prompt.includes("Child prompt")) {
            return fakeAgentStep("Child found src/agent/runtime/index.ts.");
          }

          if (request.prompt.includes("Tool result from task:")) {
            return fakeAgentStep("Parent received the child result.");
          }

          return fakeAgentStep("", [
            {
              id: "task-call-1",
              source: "native" as const,
              tool: "task",
              args: {
                description: "Inspect runtime",
                prompt: "Child prompt",
                subagent_type: "explore",
              },
            },
          ]);
        },
      } as unknown as AppContext["modelGateway"],
    });

    const events = await collectRuntimeEvents(runtime.submitMessageStream([], "delegate work", undefined, { session }));
    const children = await listChildSessions(workspace, session.sessionId);
    const child = await loadSession(workspace, children[0]!.sessionId);

    expect(events.map((event) => event.type)).toEqual([
      "subagent_started",
      "subagent_event",
      "subagent_event",
      "subagent_completed",
      "tool_call",
      "message",
      "status",
    ]);
    expect(events.find((event) => event.type === "tool_call")).toMatchObject({
      label: expect.stringContaining("task: completed"),
    });
    expect(prompts.at(-1)).toContain("Child found src/agent/runtime/index.ts.");
    expect(children).toHaveLength(1);
    expect(child.metadata).toMatchObject({
      source: "subagent",
      parentSessionId: session.sessionId,
      parentToolCallId: "task-call-1",
      agentProfileId: "explore",
      title: "Inspect runtime",
    });
    expect(child.events).toEqual([
      expect.objectContaining({ kind: "message", role: "assistant", text: "Child found src/agent/runtime/index.ts." }),
      expect.objectContaining({ kind: "status", status: "ready" }),
    ]);
  });

  it("runs multiple task calls concurrently while preserving parent result order", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-task-parallel-"));
    const session = await createSession(workspace);
    const prompts: string[] = [];
    let releaseChildA: (() => void) | undefined;
    const childAReleased = new Promise<void>((resolve) => {
      releaseChildA = resolve;
    });
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateAgentStep(request: { prompt: string }) {
          prompts.push(request.prompt);

          if (request.prompt.includes("Child A")) {
            await childAReleased;
            return fakeAgentStep("A result");
          }

          if (request.prompt.includes("Child B")) {
            return fakeAgentStep("B result");
          }

          if (request.prompt.includes("Tool result from task:")) {
            return fakeAgentStep("Parent received both task results.");
          }

          return fakeAgentStep("", [
            {
              id: "task-a",
              source: "native" as const,
              tool: "task",
              args: { description: "A", prompt: "Child A", subagent_type: "explore" },
            },
            {
              id: "task-b",
              source: "native" as const,
              tool: "task",
              args: { description: "B", prompt: "Child B", subagent_type: "explore" },
            },
          ]);
        },
      } as unknown as AppContext["modelGateway"],
    });

    const eventsPromise = collectRuntimeEvents(
      runtime.submitMessageStream([], "delegate twice", undefined, { session })
    );
    await waitForPrompt(prompts, "Child B");
    releaseChildA?.();
    const events = await eventsPromise;
    const firstCompletionIndex = events.findIndex((event) => event.type === "subagent_completed");
    const startedBeforeCompletion = events
      .slice(0, firstCompletionIndex)
      .filter((event) => event.type === "subagent_started");
    const parentResultPrompt = prompts.find((prompt) => prompt.includes("Tool result from task:")) ?? "";

    expect(startedBeforeCompletion).toHaveLength(2);
    expect(parentResultPrompt.indexOf("A result")).toBeLessThan(parentResultPrompt.indexOf("B result"));
    expect(
      events
        .filter((event) => event.type === "tool_call")
        .map((event) => (event.type === "tool_call" ? event.label : ""))
    ).toEqual([expect.stringContaining("task: completed"), expect.stringContaining("task: completed")]);
  });

  it("runs explicitly parallel-safe read-only tool calls from one model step", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-read-parallel-"));
    await writeFile(join(workspace, "a.txt"), "A\n");
    await writeFile(join(workspace, "b.txt"), "B\n");
    const prompts: string[] = [];
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateAgentStep(request: { prompt: string }) {
          prompts.push(request.prompt);

          if (request.prompt.includes("Tool result from read_file")) {
            return fakeAgentStep("Read both files.");
          }

          return fakeAgentStep("", [
            {
              id: "read-a",
              source: "native" as const,
              tool: "read_file",
              args: { path: "a.txt" },
            },
            {
              id: "read-b",
              source: "native" as const,
              tool: "read_file",
              args: { path: "b.txt" },
            },
          ]);
        },
      } as unknown as AppContext["modelGateway"],
    });

    const events = await runtime.submitMessage([], "read both files");
    const parentResultPrompt = prompts.find((prompt) => prompt.includes("Tool result from read_file")) ?? "";

    expect(
      events
        .filter((event) => event.type === "tool_call")
        .map((event) => (event.type === "tool_call" ? event.label : ""))
    ).toEqual(["read_file: a.txt", "read_file: b.txt"]);
    expect(parentResultPrompt.indexOf('"a.txt"')).toBeLessThan(parentResultPrompt.indexOf('"b.txt"'));
  });

  it("propagates aborts through the runtime stream path", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-stream-abort-"));
    const abortController = new AbortController();
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateAgentStep(request: { abortSignal?: AbortSignal }) {
          return new Promise<never>((_, reject) => {
            if (request.abortSignal?.aborted) {
              reject(new DOMException("Aborted", "AbortError"));
              return;
            }

            request.abortSignal?.addEventListener(
              "abort",
              () => {
                reject(new DOMException("Aborted", "AbortError"));
              },
              { once: true }
            );
          });
        },
      } as unknown as AppContext["modelGateway"],
    });

    const iterator = runtime.submitMessageStream([], "abort", abortController.signal)[Symbol.asyncIterator]();
    const pending = iterator.next();
    abortController.abort();

    await expect(pending).rejects.toThrow(/Aborted/u);
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it("logs each prompt sent to the model at debug level", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    await writeFile(join(workspace, "notes.txt"), "hello\n");
    const debugEntries: Array<{ payload: Record<string, unknown>; message: string }> = [];
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      logger: {
        debug(payload: Record<string, unknown>, message: string) {
          debugEntries.push({ payload, message });
        },
        trace() {},
        error() {},
      } as unknown as AppContext["logger"],
      modelGateway: {
        async generateText() {
          return debugEntries.filter((entry) => entry.payload.event === "model_prompt").length === 1
            ? {
                text: JSON.stringify({ tool: "read_file", args: { path: "notes.txt" } }),
                providerId: "fake",
                modelId: "fake-agent",
                purpose: "agent.primary" as const,
              }
            : {
                text: "Read notes.txt.",
                providerId: "fake",
                modelId: "fake-agent",
                purpose: "agent.primary" as const,
              };
        },
      } as unknown as AppContext["modelGateway"],
    });

    await runtime.submitMessage([], "read notes");

    const promptEntries = debugEntries.filter((entry) => entry.payload.event === "model_prompt");
    expect(promptEntries).toHaveLength(2);
    expect(promptEntries[0]?.message).toBe("model prompt");
    expect(promptEntries[0]?.payload).toEqual(
      expect.objectContaining({
        purpose: "agent.primary",
        afterTool: undefined,
        prompt: expect.stringContaining("read notes"),
        promptLength: expect.any(Number),
        system: expect.any(String),
        systemLength: expect.any(Number),
      })
    );
    expect(promptEntries[1]?.message).toBe("model prompt after tool");
    expect(promptEntries[1]?.payload).toEqual(
      expect.objectContaining({
        purpose: "agent.primary",
        afterTool: "read_file",
        prompt: expect.stringContaining('Tool result from read_file "notes.txt":'),
        promptLength: expect.any(Number),
        system: expect.any(String),
        systemLength: expect.any(Number),
      })
    );
  });

  it("injects an L1 context pack into runtime model prompts when KB is ready", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    await mkdir(join(workspace, "topchester-kb", "l1-files", "src", "tui"), { recursive: true });
    await writeFile(join(workspace, "topchester-kb", "manifest.json"), '{"l1":{"currentEntries":1}}\n');
    await writeFile(
      join(workspace, "topchester-kb", "l1-files", "src", "tui", "status.ts.json"),
      `${JSON.stringify(
        {
          $schema: "../schema/file-entry.v1.json",
          id: "file:src/tui/status.ts",
          layer: "L1",
          type: "file",
          path: "src/tui/status.ts",
          language: "typescript",
          content_hash: `sha256:${"f".repeat(64)}`,
          size_bytes: 222,
          last_scanned_at: "2026-05-14T00:00:00Z",
          scan_status: "current",
          summary: "Renders the TUI status bar.",
          responsibilities: ["Show status bar details."],
          symbols: [],
          imports: [],
          exports: [],
          module_ids: [],
          feature_ids: [],
          test_ids: [],
          evidence: [{ kind: "path", value: "src/tui/status.ts" }],
          confidence: "medium",
        },
        null,
        2
      )}\n`
    );
    const prompts: string[] = [];
    const runtime = new TopchesterAgentRuntime(
      {
        ...createTestContext(workspace),
        modelGateway: {
          async generateText(request: { prompt: string }) {
            prompts.push(request.prompt);
            return {
              text: "Use src/tui/status.ts.",
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
            };
          },
        } as unknown as AppContext["modelGateway"],
      },
      { disableL1Context: false }
    );

    const events = await runtime.submitMessage([], "status bar");

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "message", role: "assistant", text: "Use src/tui/status.ts." }),
      ])
    );
    expect(prompts[0]).toContain("Topchester KB context pack:");
    expect(prompts[0]).toContain("src/tui/status.ts");
    expect(prompts[0]).toContain("Conversation:\nUser: status bar");
  });

  it("uses static Topchester skill guidance when the project KB is missing", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-skill-runtime-"));
    const prompts: string[] = [];
    const systems: string[] = [];
    const runtime = new TopchesterAgentRuntime(
      {
        ...createTestContext(workspace),
        modelGateway: {
          async generateText(request: { prompt: string; system: string }) {
            prompts.push(request.prompt);
            systems.push(request.system);
            return {
              text: "Use top-level providers.",
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
            };
          },
        } as unknown as AppContext["modelGateway"],
      },
      { disableL1Context: false }
    );

    await runtime.submitMessage([], "How does Topchester configuration work?");

    expect(prompts[0]).not.toContain("Topchester KB context pack:");
    expect(systems[0]).toContain("load the `topchester` skill with skill_view before answering");
  });

  it("skips L1 context pack injection when disabled by env", async () => {
    const previous = process.env.TOPCHESTER_DISABLE_L1_CONTEXT;
    process.env.TOPCHESTER_DISABLE_L1_CONTEXT = "1";

    try {
      const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
      await mkdir(join(workspace, "topchester-kb", "l1-files", "src", "tui"), { recursive: true });
      await writeFile(join(workspace, "topchester-kb", "manifest.json"), '{"l1":{"currentEntries":1}}\n');
      await writeFile(
        join(workspace, "topchester-kb", "l1-files", "src", "tui", "status.ts.json"),
        `${JSON.stringify(
          {
            $schema: "../schema/file-entry.v1.json",
            id: "file:src/tui/status.ts",
            layer: "L1",
            type: "file",
            path: "src/tui/status.ts",
            language: "typescript",
            content_hash: `sha256:${"f".repeat(64)}`,
            size_bytes: 222,
            last_scanned_at: "2026-05-14T00:00:00Z",
            scan_status: "current",
            summary: "Renders the TUI status bar.",
            responsibilities: ["Show status bar details."],
            symbols: [],
            imports: [],
            exports: [],
            module_ids: [],
            feature_ids: [],
            test_ids: [],
            evidence: [{ kind: "path", value: "src/tui/status.ts" }],
            confidence: "medium",
          },
          null,
          2
        )}\n`
      );
      const prompts: string[] = [];
      const runtime = new TopchesterAgentRuntime({
        ...createTestContext(workspace),
        modelGateway: {
          async generateText(request: { prompt: string }) {
            prompts.push(request.prompt);
            return {
              text: "Raw prompt only.",
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
            };
          },
        } as unknown as AppContext["modelGateway"],
      });

      await runtime.submitMessage([{ role: "assistant", text: "Earlier answer." }], "status bar");

      expect(prompts[0]).toBe("Assistant: Earlier answer.\n\nUser: status bar");
      expect(prompts[0]).not.toContain("Topchester KB context pack:");
      expect(prompts[0]).not.toContain("src/tui/status.ts");
    } finally {
      if (previous === undefined) {
        delete process.env.TOPCHESTER_DISABLE_L1_CONTEXT;
      } else {
        process.env.TOPCHESTER_DISABLE_L1_CONTEXT = previous;
      }
    }
  });

  it("formats write_file tool calls and results for the final model prompt", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    const prompts: string[] = [];
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateText(request: { prompt: string }) {
          prompts.push(request.prompt);

          return prompts.length === 1
            ? {
                text: JSON.stringify({
                  tool: "write_file",
                  args: {
                    path: "test/example.test.ts",
                    content: "it('works', () => {});\n",
                    create_parent_dirs: true,
                  },
                }),
                providerId: "fake",
                modelId: "fake-agent",
                purpose: "agent.primary" as const,
              }
            : {
                text: "Created test/example.test.ts.",
                providerId: "fake",
                modelId: "fake-agent",
                purpose: "agent.primary" as const,
              };
        },
      } as unknown as AppContext["modelGateway"],
    });

    const events = await runtime.submitMessage([], "add a test");

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool_call", label: "write_file: test/example.test.ts (created +1)" }),
        expect.objectContaining({ type: "message", role: "assistant", text: "Created test/example.test.ts." }),
      ])
    );
    expect(await readFile(join(workspace, "test", "example.test.ts"), "utf8")).toBe("it('works', () => {});\n");
    expect(prompts[1]).toContain('Tool result from write_file "test/example.test.ts":');
    expect(prompts[1]).toContain("after_hash: sha256:");
    expect(prompts[1]).toContain("bytes_written: 23");
    expect(prompts[1]).toContain("line_count: 1");
    expect(prompts[1]).toContain("kb_state: needs_sync");
    expect(prompts[1]).toContain("created_parent_dirs: test");
    expect(prompts[1]).toContain("summary: created +1");
    expect(prompts[1]).not.toContain("it('works'");
  });

  it("emits task-plan events after successful plan_todo calls", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    await writeFile(join(workspace, "notes.txt"), "hello\n");
    const prompts: string[] = [];
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateText(request: { prompt: string }) {
          prompts.push(request.prompt);

          if (prompts.length === 1) {
            return {
              text: JSON.stringify({
                tool: "plan_todo",
                args: {
                  items: [
                    { text: "Create visible plan", status: "completed" },
                    { text: "Read notes", status: "in_progress" },
                  ],
                },
              }),
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
            };
          }

          if (prompts.length === 2) {
            return {
              text: JSON.stringify({ tool: "read_file", args: { path: "notes.txt" } }),
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
            };
          }

          return {
            text: "Read notes.txt.",
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    const events = await runtime.submitMessage([], "read notes with a plan");
    const taskPlanEvent = events.find((event) => event.type === "task_plan");

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool_call", label: "plan_todo: 2 items, 1 active" }),
        expect.objectContaining({ type: "tool_call", label: "read_file: notes.txt" }),
        expect.objectContaining({ type: "message", role: "assistant", text: "Read notes.txt." }),
      ])
    );
    expect(taskPlanEvent?.type === "task_plan" ? taskPlanEvent.plan.items : undefined).toEqual([
      { text: "Create visible plan", status: "completed" },
      { text: "Read notes", status: "in_progress" },
    ]);
    expect(prompts[1]).toContain("Tool result from plan_todo:");
    expect(prompts[1]).toContain("current: Read notes");
    expect(prompts[1]).toContain("visible plan when one is active");
  });

  it("suppresses completed-only plan_todo before appended prose when no plan is open", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    let calls = 0;
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateText() {
          calls += 1;

          if (calls === 1) {
            return {
              text: `{"tool":"plan_todo","args":{"items":[{"text":"Locate user message styling","status":"completed"},{"text":"Report exact background
 source","status":"completed"}]}}The background is set by ui.softBackground.`,
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
            };
          }

          return {
            text: "This second response should not be needed.",
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    const events = await runtime.submitMessage([], "where is the user message background set?");

    expect(events).toEqual([
      expect.objectContaining({
        type: "message",
        role: "assistant",
        text: "The background is set by ui.softBackground.",
      }),
      { type: "status", status: "ready" },
    ]);
    expect(events.some((event) => event.type === "tool_call")).toBe(false);
    expect(events.some((event) => event.type === "task_plan")).toBe(false);
    expect(JSON.stringify(events)).not.toContain('"tool":"plan_todo"');
    expect(JSON.stringify(events)).not.toContain("Report exact background");
  });

  it("suppresses completed-only plan_todo before appended prose after previous tools", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    await writeFile(join(workspace, "src.txt"), "content\n");
    let calls = 0;
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateText() {
          calls += 1;

          if (calls === 1) {
            return {
              text: JSON.stringify({ tool: "read_file", args: { path: "src.txt" } }),
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
            };
          }

          return {
            text: `{"tool":"plan_todo","args":{"items":[{"text":"Inspect message rendering","status":"completed"},{"text":"Trace background color
 source","status":"completed"}]}}The user message background is set in src/tui/layout.ts.`,
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    const events = await runtime.submitMessage([], "where is the user message background set?");

    expect(events).toEqual([
      expect.objectContaining({ type: "tool_call", label: "read_file: src.txt" }),
      expect.objectContaining({
        type: "message",
        role: "assistant",
        text: "The user message background is set in src/tui/layout.ts.",
      }),
      { type: "status", status: "ready" },
    ]);
    expect(events.some((event) => event.type === "task_plan")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("The answer should not be rendered yet.");
    expect(
      events.some((event) => event.type === "message" && event.role === "assistant" && event.text.includes("plan_todo"))
    ).toBe(false);
  });

  it("strips completed-only plan_todo from final text when the model gateway did not classify it as a tool call", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateAgentStep() {
          return {
            text: `{"tool":"plan_todo","args":{"items":[{"text":"Inspect user message rendering","status":"completed"},{"text":"Locate background color
 source","status":"completed"}]}}The user-message background is set in src/tui/layout.ts, not in src/tui/messages.ts.`,
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
            toolCalls: [],
            toolProtocol: "native-openai-compatible" as const,
            protocolAttempts: [{ protocol: "native-openai-compatible" as const, status: "used" as const }],
            providerRejectedTools: false,
            warnings: [],
            openRouterRoutingApplied: false,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    const events = await runtime.submitMessage([], "where is the user message background set?");

    expect(events).toEqual([
      expect.objectContaining({
        type: "message",
        role: "assistant",
        text: "The user-message background is set in src/tui/layout.ts, not in src/tui/messages.ts.",
      }),
      { type: "status", status: "ready" },
    ]);
    expect(events.some((event) => event.type === "tool_call")).toBe(false);
    expect(events.some((event) => event.type === "task_plan")).toBe(false);
    expect(JSON.stringify(events)).not.toContain('"tool":"plan_todo"');
    expect(JSON.stringify(events)).not.toContain("Locate background color");
  });

  it("requires an open task plan to be closed before the final answer", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    const prompts: string[] = [];
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateText(request: { prompt: string }) {
          prompts.push(request.prompt);

          if (prompts.length === 1) {
            return {
              text: JSON.stringify({
                tool: "plan_todo",
                args: {
                  items: [
                    { text: "Inspect", status: "completed" },
                    { text: "Review diff", status: "in_progress" },
                  ],
                },
              }),
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
            };
          }

          if (prompts.length === 2) {
            return {
              text: "Done too early.",
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
            };
          }

          if (prompts.length === 3) {
            return {
              text: JSON.stringify({
                tool: "plan_todo",
                args: {
                  items: [
                    { text: "Inspect", status: "completed" },
                    { text: "Review diff", status: "completed" },
                  ],
                },
              }),
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
            };
          }

          return {
            text: "Done after closing plan.",
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    const events = await runtime.submitMessage([], "do multi-step work");
    const assistantMessages = events.filter((event) => event.type === "message" && event.role === "assistant");
    const taskPlanEvents = events.filter((event) => event.type === "task_plan");

    expect(assistantMessages).toEqual([expect.objectContaining({ text: "Done after closing plan." })]);
    expect(taskPlanEvents.at(-1)?.type === "task_plan" ? taskPlanEvents.at(-1)?.plan.items : undefined).toEqual([
      { text: "Inspect", status: "completed" },
      { text: "Review diff", status: "completed" },
    ]);
    expect(prompts[2]).toContain("The visible plan still has unfinished items");
    expect(prompts[2]).toContain("Done too early.");
  });

  it("clears an open task plan if the model ignores the close-plan reminder", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    let calls = 0;
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateText() {
          calls += 1;

          if (calls === 1) {
            return {
              text: JSON.stringify({
                tool: "plan_todo",
                args: {
                  items: [
                    { text: "Inspect", status: "completed" },
                    { text: "Review diff", status: "in_progress" },
                  ],
                },
              }),
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
            };
          }

          return {
            text: "Done but still ignored plan.",
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    const events = await runtime.submitMessage([], "do multi-step work");
    const taskPlanEvents = events.filter((event) => event.type === "task_plan");

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "message", role: "assistant", text: "Done but still ignored plan." }),
      ])
    );
    expect(taskPlanEvents.at(-1)?.type === "task_plan" ? taskPlanEvents.at(-1)?.plan.items : undefined).toEqual([]);
  });

  it("recovers a text tool call when the gateway omits normalized tool calls", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    await writeFile(join(workspace, "notes.txt"), "hello\n");
    const textResult = (text: string) => ({
      text,
      providerId: "fake",
      modelId: "fake-agent",
      purpose: "agent.primary" as const,
      toolCalls: [],
      toolProtocol: "text-json" as const,
      protocolAttempts: [{ protocol: "text-json" as const, status: "used" as const }],
      providerRejectedTools: false,
      warnings: [],
      openRouterRoutingApplied: false,
    });
    let calls = 0;
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateAgentStep() {
          calls += 1;

          if (calls === 1) {
            return textResult(
              JSON.stringify({
                tool: "plan_todo",
                args: {
                  items: [
                    { text: "Plan", status: "completed" },
                    { text: "Read notes", status: "in_progress" },
                  ],
                },
              })
            );
          }

          if (calls === 2) {
            return textResult(JSON.stringify({ tool: "read_file", args: { path: "notes.txt" } }));
          }

          if (calls === 3) {
            return textResult(
              JSON.stringify({
                tool: "plan_todo",
                args: {
                  items: [
                    { text: "Plan", status: "completed" },
                    { text: "Read notes", status: "completed" },
                  ],
                },
              })
            );
          }

          return textResult("Read notes.txt.");
        },
      } as unknown as AppContext["modelGateway"],
    });

    const events = await runtime.submitMessage([], "read notes with a plan");

    expect(
      events
        .filter((event) => event.type === "tool_call")
        .map((event) => (event.type === "tool_call" ? event.label : ""))
    ).toEqual(["plan_todo: 2 items, 1 active", "read_file: notes.txt", "plan_todo: 2 items, 0 active"]);
    expect(events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "message", role: "assistant", text: "Read notes.txt." })])
    );
  });

  it("continues executing tool calls until the model gives a final answer", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    await writeFile(join(workspace, "test-foo.ts"), 'console.log("hello");\n');
    const prompts: string[] = [];
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateText(request: { prompt: string }) {
          prompts.push(request.prompt);

          if (prompts.length === 1) {
            return {
              text: JSON.stringify({ tool: "find_file", args: { query: "test-foo.ts" } }),
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
            };
          }

          if (prompts.length === 2) {
            return {
              text: JSON.stringify({ tool: "read_file", args: { path: "test-foo.ts" } }),
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
            };
          }

          if (prompts.length === 3) {
            return {
              text: JSON.stringify({
                tool: "edit_file",
                args: {
                  path: "test-foo.ts",
                  edits: [{ old_text: 'console.log("hello");\n', new_text: 'console.log("HELLO, WORLD!!!!");\n' }],
                },
              }),
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
            };
          }

          return {
            text: "Updated test-foo.ts.",
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    const events = await runtime.submitMessage([], 'change the console log text to say "HELLO, WORLD!!!!"');

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool_call", label: "find_file: test-foo.ts in ." }),
        expect.objectContaining({ type: "tool_call", label: "read_file: test-foo.ts" }),
        expect.objectContaining({ type: "tool_call", label: "edit_file: test-foo.ts (changed +1/-1)" }),
        expect.objectContaining({ type: "message", role: "assistant", text: "Updated test-foo.ts." }),
      ])
    );
    expect(prompts).toHaveLength(4);
    expect(prompts[1]).toContain(
      "find_file results are paths only; if the user asked to read or answer from file contents, call read_file on the relevant path before answering. Do not ask the user to provide the read_file result or permission."
    );
  });

  it("returns tool errors to the model instead of failing the chat", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    const prompts: string[] = [];
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateText(request: { prompt: string }) {
          prompts.push(request.prompt);

          return prompts.length === 1
            ? {
                text: JSON.stringify({ tool: "read_file", args: { path: "missing.txt" } }),
                providerId: "fake",
                modelId: "fake-agent",
                purpose: "agent.primary" as const,
              }
            : {
                text: "missing.txt does not exist.",
                providerId: "fake",
                modelId: "fake-agent",
                purpose: "agent.primary" as const,
              };
        },
      } as unknown as AppContext["modelGateway"],
    });

    const events = await runtime.submitMessage([], "read missing file");

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_call",
          label: expect.stringContaining("read_file failed:"),
        }),
        expect.objectContaining({ type: "message", role: "assistant", text: "missing.txt does not exist." }),
      ])
    );
    expect(events.at(-1)).toEqual({ type: "status", status: "ready" });
    expect(prompts[1]).toContain("Tool result from read_file:");
    expect(prompts[1]).toContain("Error:");
  });

  it("asks for bash approval and resumes the blocked tool call when allowed once", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    const prompts: string[] = [];
    const approvalRequests: Array<{ command: string; reason: string }> = [];
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateAgentStep(request: { prompt: string }) {
          prompts.push(request.prompt);

          if (prompts.length === 1) {
            return {
              text: "",
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
              toolCalls: [{ id: "bash-0", tool: "bash", args: { command: "node --version" }, source: "text-json" }],
              toolProtocol: "text-json" as const,
              protocolAttempts: [],
              providerRejectedTools: false,
              warnings: [],
              openRouterRoutingApplied: false,
            };
          }

          return {
            text: "Node version reported.",
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
            toolCalls: [],
            toolProtocol: "text-json" as const,
            protocolAttempts: [],
            providerRejectedTools: false,
            warnings: [],
            openRouterRoutingApplied: false,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    const events = await runtime.submitMessage([], "check node version", undefined, undefined, {
      requestBashApproval: async (request) => {
        approvalRequests.push({ command: request.command, reason: request.reason });

        return "run_once";
      },
    });

    expect(approvalRequests).toEqual([
      {
        command: "node --version",
        reason: "bash policy requires approval for 'node --version'.",
      },
    ]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool_call", label: expect.stringContaining("bash: node --version") }),
        expect.objectContaining({ type: "message", role: "assistant", text: "Node version reported." }),
      ])
    );
    expect(prompts[1]).toContain("Tool result from bash via node --version:");
    expect(prompts[1]).toContain("stdout:");
  });

  it("auto-approves approval-required bash commands when runtime approval mode is enabled", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    const prompts: string[] = [];
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateAgentStep(request: { prompt: string }) {
          prompts.push(request.prompt);

          if (prompts.length === 1) {
            return {
              text: "",
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
              toolCalls: [{ id: "bash-0", tool: "bash", args: { command: "node --version" }, source: "text-json" }],
              toolProtocol: "text-json" as const,
              protocolAttempts: [],
              providerRejectedTools: false,
              warnings: [],
              openRouterRoutingApplied: false,
            };
          }

          return {
            text: "Node version reported.",
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
            toolCalls: [],
            toolProtocol: "text-json" as const,
            protocolAttempts: [],
            providerRejectedTools: false,
            warnings: [],
            openRouterRoutingApplied: false,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    const events = await runtime.submitMessage([], "check node version", undefined, undefined, {
      userApprovalMode: "auto_allow",
    });

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "permission_auto_approved",
          approvalMode: "auto_allow",
          permissionMode: "bash",
          command: "node --version",
          reason: "bash policy requires approval for 'node --version'.",
        }),
        expect.objectContaining({ type: "tool_call", label: expect.stringContaining("bash: node --version") }),
        expect.objectContaining({ type: "message", role: "assistant", text: "Node version reported." }),
      ])
    );
    expect(prompts[1]).toContain("Tool result from bash via node --version:");
    expect(prompts[1]).toContain("stdout:");
  });

  it("does not auto-approve destructive bash policy rejections", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    const prompts: string[] = [];
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateAgentStep(request: { prompt: string }) {
          prompts.push(request.prompt);

          if (prompts.length === 1) {
            return {
              text: "",
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
              toolCalls: [{ id: "bash-0", tool: "bash", args: { command: "rm -rf dist" }, source: "text-json" }],
              toolProtocol: "text-json" as const,
              protocolAttempts: [],
              providerRejectedTools: false,
              warnings: [],
              openRouterRoutingApplied: false,
            };
          }

          return {
            text: "Skipped destructive command.",
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
            toolCalls: [],
            toolProtocol: "text-json" as const,
            protocolAttempts: [],
            providerRejectedTools: false,
            warnings: [],
            openRouterRoutingApplied: false,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    const events = await runtime.submitMessage([], "remove dist", undefined, undefined, {
      userApprovalMode: "auto_allow",
    });

    expect(events.some((event) => event.type === "permission_auto_approved")).toBe(false);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_call",
          label:
            "bash failed: bash policy rejected 'rm -rf dist' because it looks destructive: recursive forced deletion.",
        }),
        expect.objectContaining({ type: "message", role: "assistant", text: "Skipped destructive command." }),
      ])
    );
    expect(prompts[1]).toContain("Error:");
    expect(prompts[1]).toContain("recursive forced deletion");
  });

  it("returns bash cancellation to the model when approval is denied", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    const prompts: string[] = [];
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateAgentStep(request: { prompt: string }) {
          prompts.push(request.prompt);

          if (prompts.length === 1) {
            return {
              text: "",
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
              toolCalls: [{ id: "bash-0", tool: "bash", args: { command: "node --version" }, source: "text-json" }],
              toolProtocol: "text-json" as const,
              protocolAttempts: [],
              providerRejectedTools: false,
              warnings: [],
              openRouterRoutingApplied: false,
            };
          }

          return {
            text: "Skipped.",
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
            toolCalls: [],
            toolProtocol: "text-json" as const,
            protocolAttempts: [],
            providerRejectedTools: false,
            warnings: [],
            openRouterRoutingApplied: false,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    const events = await runtime.submitMessage([], "check node version", undefined, undefined, {
      requestBashApproval: async () => "cancel",
    });

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_call",
          label: "bash failed: bash cancelled by user for 'node --version'.",
        }),
        expect.objectContaining({ type: "message", role: "assistant", text: "Skipped." }),
      ])
    );
    expect(prompts[1]).toContain("Error:");
    expect(prompts[1]).toContain("bash cancelled by user for 'node --version'.");
  });

  it("asks whether to continue or abort after the tool call limit", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    let calls = 0;
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateAgentStep() {
          calls += 1;

          return {
            text: "",
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
            toolCalls: [
              {
                id: `list-files-${calls}`,
                tool: "list_files",
                args: { path: ".", recursive: false, limit: 1 },
                source: "text-json",
              },
            ],
            toolProtocol: "text-json" as const,
            protocolAttempts: [],
            providerRejectedTools: false,
            warnings: [],
            openRouterRoutingApplied: false,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    const events = await runtime.submitMessage([], "keep listing");
    const choiceEvent = events.find((event): event is Extract<AgentRuntimeEvent, { type: "choice" }> => {
      return event.type === "choice";
    });

    expect(events.filter((event) => event.type === "tool_call")).toHaveLength(75);
    expect(calls).toBe(76);
    expect(choiceEvent).toEqual(
      expect.objectContaining({
        tone: "warning",
        title: "Tool call limit reached",
        actions: [
          { label: "Continue", value: "Continue the previous task from where you stopped." },
          { label: "Abort", value: "__topchester_abort__" },
        ],
      })
    );
    expect(events.at(-1)).toEqual({ type: "status", status: "ready" });
  });

  it("honors TOPCHESTER_MAX_TOOL_CALLS_PER_TURN", async () => {
    const previous = process.env.TOPCHESTER_MAX_TOOL_CALLS_PER_TURN;
    process.env.TOPCHESTER_MAX_TOOL_CALLS_PER_TURN = "2";

    try {
      const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
      let calls = 0;
      const runtime = new TopchesterAgentRuntime({
        ...createTestContext(workspace),
        modelGateway: {
          async generateAgentStep() {
            calls += 1;

            return {
              text: "",
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
              toolCalls: [
                {
                  id: `list-files-${calls}`,
                  tool: "list_files",
                  args: { path: ".", recursive: false, limit: 1 },
                  source: "text-json",
                },
              ],
              toolProtocol: "text-json" as const,
              protocolAttempts: [],
              providerRejectedTools: false,
              warnings: [],
              openRouterRoutingApplied: false,
            };
          },
        } as unknown as AppContext["modelGateway"],
      });

      const events = await runtime.submitMessage([], "keep listing");
      const choiceEvent = events.find((event): event is Extract<AgentRuntimeEvent, { type: "choice" }> => {
        return event.type === "choice";
      });

      expect(events.filter((event) => event.type === "tool_call")).toHaveLength(2);
      expect(calls).toBe(3);
      expect(choiceEvent).toEqual(
        expect.objectContaining({
          tone: "warning",
          title: "Tool call limit reached",
          body: "Stopped after 2 tool calls in one turn. Continue starts another turn; abort leaves the call stopped.",
        })
      );
    } finally {
      if (previous === undefined) {
        delete process.env.TOPCHESTER_MAX_TOOL_CALLS_PER_TURN;
      } else {
        process.env.TOPCHESTER_MAX_TOOL_CALLS_PER_TURN = previous;
      }
    }
  });

  it("disables the tool call limit when TOPCHESTER_MAX_TOOL_CALLS_PER_TURN is zero", async () => {
    const previous = process.env.TOPCHESTER_MAX_TOOL_CALLS_PER_TURN;
    process.env.TOPCHESTER_MAX_TOOL_CALLS_PER_TURN = "0";

    try {
      const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
      let calls = 0;
      const runtime = new TopchesterAgentRuntime({
        ...createTestContext(workspace),
        modelGateway: {
          async generateAgentStep() {
            calls += 1;

            if (calls === 4) {
              return fakeAgentStep("Done.", []);
            }

            return {
              text: "",
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
              toolCalls: [
                {
                  id: `list-files-${calls}`,
                  tool: "list_files",
                  args: { path: ".", recursive: false, limit: 1 },
                  source: "text-json",
                },
              ],
              toolProtocol: "text-json" as const,
              protocolAttempts: [],
              providerRejectedTools: false,
              warnings: [],
              openRouterRoutingApplied: false,
            };
          },
        } as unknown as AppContext["modelGateway"],
      });

      const events = await runtime.submitMessage([], "keep listing");

      expect(events.filter((event) => event.type === "tool_call")).toHaveLength(3);
      expect(calls).toBe(4);
      expect(events.some((event) => event.type === "choice")).toBe(false);
      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "message", text: "Done." })]));
    } finally {
      if (previous === undefined) {
        delete process.env.TOPCHESTER_MAX_TOOL_CALLS_PER_TURN;
      } else {
        process.env.TOPCHESTER_MAX_TOOL_CALLS_PER_TURN = previous;
      }
    }
  });

  it("rejects consecutive plan_todo calls", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    await writeFile(join(workspace, "data.txt"), "hello\n");
    let calls = 0;
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateAgentStep() {
          calls += 1;

          if (calls === 1) {
            return fakeAgentStep("", [
              {
                id: "plan-1",
                tool: "plan_todo",
                args: {
                  items: [
                    { text: "Inspect data", status: "in_progress" },
                    { text: "Answer", status: "pending" },
                  ],
                },
                source: "text-json",
              },
            ]);
          }

          if (calls === 2) {
            return fakeAgentStep("", [
              {
                id: "plan-2",
                tool: "plan_todo",
                args: {
                  items: [
                    { text: "Inspect data carefully", status: "in_progress" },
                    { text: "Answer", status: "pending" },
                  ],
                },
                source: "text-json",
              },
            ]);
          }

          if (calls === 3) {
            return fakeAgentStep("", [
              {
                id: "read-1",
                tool: "read_file",
                args: { path: "data.txt" },
                source: "text-json",
              },
            ]);
          }

          if (calls === 4) {
            return fakeAgentStep("", [
              {
                id: "plan-3",
                tool: "plan_todo",
                args: {
                  items: [
                    { text: "Inspect data", status: "completed" },
                    { text: "Answer", status: "completed" },
                  ],
                },
                source: "text-json",
              },
            ]);
          }

          return fakeAgentStep("done");
        },
      } as unknown as AppContext["modelGateway"],
    });

    const events = await runtime.submitMessage([], "inspect and answer");

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_call",
          call: expect.objectContaining({ tool: "plan_todo" }),
          label: expect.stringContaining("previous tool call was also plan_todo"),
        }),
        expect.objectContaining({ type: "message", role: "assistant", text: "done" }),
      ])
    );
    expect(events.filter((event) => event.type === "task_plan")).toHaveLength(2);
  });

  it("caps plan_todo updates in compact mode", async () => {
    const previousMode = process.env.TOPCHESTER_PLAN_TODO_MODE;
    const previousMax = process.env.TOPCHESTER_MAX_PLAN_TODO_UPDATES_PER_TURN;
    process.env.TOPCHESTER_PLAN_TODO_MODE = "compact";
    process.env.TOPCHESTER_MAX_PLAN_TODO_UPDATES_PER_TURN = "1";

    try {
      const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
      await writeFile(join(workspace, "data.txt"), "hello\n");
      let calls = 0;
      const runtime = new TopchesterAgentRuntime({
        ...createTestContext(workspace),
        modelGateway: {
          async generateAgentStep() {
            calls += 1;

            if (calls === 1) {
              return fakeAgentStep("", [
                {
                  id: "plan-1",
                  tool: "plan_todo",
                  args: {
                    items: [
                      { text: "Inspect data", status: "in_progress" },
                      { text: "Answer", status: "pending" },
                    ],
                  },
                  source: "text-json",
                },
              ]);
            }

            if (calls === 2) {
              return fakeAgentStep("", [
                {
                  id: "read-1",
                  tool: "read_file",
                  args: { path: "data.txt" },
                  source: "text-json",
                },
              ]);
            }

            if (calls === 3) {
              return fakeAgentStep("", [
                {
                  id: "plan-2",
                  tool: "plan_todo",
                  args: {
                    items: [
                      { text: "Inspect data", status: "completed" },
                      { text: "Answer", status: "in_progress" },
                    ],
                  },
                  source: "text-json",
                },
              ]);
            }

            return fakeAgentStep("done");
          },
        } as unknown as AppContext["modelGateway"],
      });

      const events = await runtime.submitMessage([], "inspect and answer");

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "tool_call",
            call: expect.objectContaining({ tool: "plan_todo" }),
            label: expect.stringContaining("configured limit of 1"),
          }),
          expect.objectContaining({ type: "message", role: "assistant", text: "done" }),
        ])
      );
      expect(events.filter((event) => event.type === "task_plan")).toHaveLength(1);
    } finally {
      if (previousMode === undefined) {
        delete process.env.TOPCHESTER_PLAN_TODO_MODE;
      } else {
        process.env.TOPCHESTER_PLAN_TODO_MODE = previousMode;
      }
      if (previousMax === undefined) {
        delete process.env.TOPCHESTER_MAX_PLAN_TODO_UPDATES_PER_TURN;
      } else {
        process.env.TOPCHESTER_MAX_PLAN_TODO_UPDATES_PER_TURN = previousMax;
      }
    }
  });

  it("keeps using text JSON for the rest of a turn after native tools are rejected", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    await writeFile(join(workspace, "data.txt"), "hello\n");
    const requests: Array<{ toolProtocol?: string }> = [];
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateAgentStep(request: { toolProtocol?: string }) {
          requests.push(request);

          if (requests.length === 1) {
            return {
              text: "",
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
              toolCalls: [{ id: "text-json-0", tool: "read_file", args: { path: "data.txt" }, source: "text-json" }],
              toolProtocol: "text-json" as const,
              protocolAttempts: [
                { protocol: "native-openai-compatible" as const, status: "failed" as const, reason: "rejected" },
                { protocol: "text-json" as const, status: "used" as const, reason: "provider rejected native tools" },
              ],
              providerRejectedTools: true,
              warnings: [],
              openRouterRoutingApplied: false,
            };
          }

          return {
            text: "Done.",
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
            toolCalls: [],
            toolProtocol: "text-json" as const,
            protocolAttempts: [
              {
                protocol: "native-openai-compatible" as const,
                status: "skipped" as const,
                reason: "toolProtocol=text-json",
              },
              { protocol: "text-json" as const, status: "used" as const, reason: "forced text JSON protocol" },
            ],
            providerRejectedTools: false,
            warnings: [],
            openRouterRoutingApplied: false,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    await runtime.submitMessage([], "read data");

    expect(requests.map((request) => request.toolProtocol)).toEqual([undefined, "text-json"]);
  });
});

function createTestContext(workspaceRoot: string): AppContext {
  return {
    workspaceRoot,
    configLoadSpec: { workspaceRoot },
    baseConfig: {},
    runtimeConfigOverrides: { modelOverrides: {}, reasoningEffortByProvider: {} },
    config: {},
    modelGateway: {
      async generateText() {
        throw new Error("model should not be called for this test");
      },
    } as unknown as AppContext["modelGateway"],
    devFlags: new Set(),
    logger: {
      debug() {},
      trace() {},
      info() {},
      warn() {},
      error() {},
    } as unknown as AppContext["logger"],
  };
}

function fakeKbModel(): AppContext["modelGateway"] {
  return {
    async generateText() {
      return {
        text: JSON.stringify({
          language: "typescript",
          summary: "Summarizes the source file.",
          responsibilities: ["Describe the file for the project knowledge base."],
          symbols: [],
          imports: [],
          exports: [],
          module_ids: [],
          feature_ids: [],
          test_ids: [],
          evidence: [{ kind: "path", value: "model-path" }],
          confidence: "medium",
        }),
        providerId: "fake",
        modelId: "fake-kb",
        purpose: "kb.summarize" as const,
      };
    },
  } as unknown as AppContext["modelGateway"];
}

function getKnowledgeStatusEvent(
  events: AgentRuntimeEvent[]
): Extract<AgentRuntimeEvent, { type: "knowledge_status" }> | undefined {
  return events.find((candidate): candidate is Extract<AgentRuntimeEvent, { type: "knowledge_status" }> => {
    return candidate.type === "knowledge_status";
  });
}

async function getRuntimeKnowledgeFolderState(
  runtime: TopchesterAgentRuntime,
  command: string
): Promise<{ exists: boolean; isDirectory: boolean } | undefined> {
  const events = await runtime.submitSlashCommand(command);
  const event = events.find((candidate) => candidate.type === "knowledge_status");

  return event?.type === "knowledge_status"
    ? { exists: event.status.kbExists, isDirectory: event.status.kbIsDirectory }
    : undefined;
}

async function collectRuntimeEvents(events: AsyncIterable<AgentRuntimeEvent>): Promise<AgentRuntimeEvent[]> {
  const collected: AgentRuntimeEvent[] = [];

  for await (const event of events) {
    collected.push(event);
  }

  return collected;
}

function normalizeRuntimeEventsForComparison(events: AgentRuntimeEvent[]): AgentRuntimeEvent[] {
  return events.map((event) =>
    event.type === "message" && event.meta !== undefined ? { ...event, meta: "<model metadata>" } : event
  );
}

function fakeAgentStep(text: string, toolCalls: Array<Record<string, unknown>> = []) {
  return {
    text,
    providerId: "fake",
    modelId: "fake-agent",
    purpose: "agent.primary" as const,
    toolCalls,
    toolProtocol: "native-openai-compatible" as const,
    protocolAttempts: [],
    providerRejectedTools: false,
    warnings: [],
    openRouterRoutingApplied: false,
  };
}

async function waitForPrompt(prompts: string[], pattern: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (prompts.some((prompt) => prompt.includes(pattern))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Timed out waiting for prompt containing ${pattern}`);
}
