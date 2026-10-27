import { readFileSync } from "node:fs";
import type { BbPluginApi, PluginCliContext } from "@get-bb/plugin-sdk";
import type { NewThreadRequest } from "@get-bb/plugin-sdk/app";
import type { BotMetadata } from "../contract";
import type { BotStore } from "./bot-store";
import type { FleetOps } from "./fleet-cli";
import { projectLaunchEnvironment, worktreeLaunchEnvironment } from "./worktree-launch";
import { resolveBotSelector, resolveProject } from "./fleet-resolve";
import { parseLaunchPresetFromFlags } from "./fleet-launch-flags";
import { assertFleetRegistryOperator } from "./fleet-authz";

type FlagMap = Record<string, string | boolean>;

export async function runMainCommand(argv: string[], ctx: PluginCliContext, bb: BbPluginApi, store: BotStore, ops: FleetOps, personalProjectId: () => Promise<string>, caller: BotMetadata | null) {
  assertFleetRegistryOperator(ctx, caller);
  const flags: FlagMap = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    if (arg === "--json" || arg === "--personal" || arg === "--worktree" || arg === "--replace") { flags[arg.slice(2)] = true; continue; }
    flags[arg.slice(2)] = argv[++i]!;
  }
  if (positional.length !== 1) throw new Error("Usage: bb bots main <bot> [--project <p> | --personal] [--worktree] [--prompt <text> | --prompt-file <p>] [--replace] [--json]");
  const bot = resolveBotSelector(store, positional[0]!);
  const personalId = await personalProjectId();
  const projectId = flags.personal ? personalId : flags.project ? (await resolveProject(bb, String(flags.project))).id : store.ownedProjects(bot.id)[0];
  if (!projectId) throw new Error("Choose --project or --personal; this bot owns no project");
  if (bot.mainThreadId && !flags.replace) {
    try {
      const existing = await bb.sdk.threads.get({ threadId: bot.mainThreadId });
      if (!existing.archivedAt) throw new Error("Bot already has a live main conversation. Pass --replace to move the main pointer.");
    } catch (error) {
      if (error instanceof Error && error.message === "Bot already has a live main conversation. Pass --replace to move the main pointer.") throw error;
    }
  }
  const warnings: string[] = [];
  const presetFromFlags = parseLaunchPresetFromFlags(flags, bot.launchPreset ?? null);
  const preset = presetFromFlags === undefined ? bot.launchPreset ?? null : presetFromFlags;
  let providerId = preset?.execution?.providerId;
  let model = preset?.execution?.model;
  let reasoningLevel = preset?.execution?.reasoningLevel ?? "medium";
  let permissionMode: "accept-edits" | "auto" | "full" = preset?.execution?.permissionMode ?? "auto";
  if (permissionMode === "full") { warnings.push("full permission was replaced with auto"); permissionMode = "auto"; }
  if (flags.provider) providerId = String(flags.provider);
  if (flags.model) model = String(flags.model);
  if (flags.reasoning) reasoningLevel = String(flags.reasoning);
  if (flags.permission === "full") { warnings.push("full permission was replaced with auto"); permissionMode = "auto"; }
  else if (flags.permission) permissionMode = String(flags.permission) as "accept-edits" | "auto";
  if (!providerId || !model) {
    const defaults = await bb.sdk.projects.defaultExecutionOptions({ projectId });
    providerId = providerId ?? defaults?.providerId;
    model = model ?? defaults?.model;
    reasoningLevel = defaults?.reasoningLevel ?? reasoningLevel;
    if (defaults?.permissionMode && defaults.permissionMode !== "full") permissionMode = defaults.permissionMode;
  }
  if (!providerId || !model) throw new Error("Provide --provider and --model or configure project defaults");
  const prompt = (typeof flags.prompt === "string" ? flags.prompt : flags["prompt-file"] ? readFileSync(String(flags["prompt-file"]).startsWith("/") ? String(flags["prompt-file"]) : `${ctx.cwd}/${flags["prompt-file"]}`, "utf8") : null) ?? preset?.initialPrompt ?? "main";
  const useWorktree = Boolean(flags.worktree) || preset?.workspace === "worktree";
  const environment: NewThreadRequest["environment"] = projectId === personalId
    ? { type: "host", hostId: bot.hostId, workspace: { type: "personal" } }
    : useWorktree ? worktreeLaunchEnvironment(bot.hostId) : projectLaunchEnvironment(bot.hostId);
  const request: NewThreadRequest = {
    projectId, providerId, model, reasoningLevel, permissionMode,
    executionInputSources: { providerId: "explicit", model: "explicit", reasoningLevel: "explicit", permissionMode: "explicit" },
    environment, input: [{ type: "text", text: prompt, mentions: [] }],
  };
  const { threadId } = await ops.startConversation({ botId: bot.id, request, makeMain: true });
  const payload = { botId: bot.id, threadId, projectId, main: true };
  return { exitCode: 0, stdout: flags.json ? JSON.stringify(payload) : `Main conversation ${threadId} for ${bot.id}`, stderr: warnings.length ? warnings.join("\n") : undefined };
}
