import type { LaunchPreset } from "./launch-preset";
import { launchPresetSchema } from "./launch-preset";

type FlagMap = Record<string, string | boolean>;

export function rejectSlashInName(name: string, label = "name") {
  if (name.includes("/")) throw new Error(`${label} must not contain '/'`);
}

export function parseLaunchPresetFromFlags(flags: FlagMap, current?: LaunchPreset | null): LaunchPreset | null | undefined {
  const touched = Boolean(
    flags.provider || flags.model || flags.reasoning || flags.permission || flags["service-tier"] ||
    flags.workspace || flags["starter-prompt"],
  );
  if (!touched) return undefined;
  const base = current ?? { execution: null, workspace: "checkout", initialPrompt: "" };
  const permissionRaw = flags.permission !== undefined ? String(flags.permission) : undefined;
  if (permissionRaw === "full") throw new Error("The fleet never runs bots in full permission mode");
  const providerId = flags.provider !== undefined ? String(flags.provider) : base.execution?.providerId;
  const model = flags.model !== undefined ? String(flags.model) : base.execution?.model;
  if ((flags.provider || flags.model) && (!providerId || !model)) {
    throw new Error("--provider and --model must be supplied together");
  }
  const execution = providerId && model ? {
    providerId,
    model,
    reasoningLevel: flags.reasoning !== undefined ? String(flags.reasoning) : (base.execution?.reasoningLevel ?? "medium"),
    ...(flags["service-tier"] !== undefined ? { serviceTier: String(flags["service-tier"]) } : base.execution?.serviceTier === undefined ? {} : { serviceTier: base.execution.serviceTier }),
    permissionMode: permissionRaw === undefined
      ? (base.execution?.permissionMode ?? "auto")
      : permissionRaw === "accept-edits" || permissionRaw === "auto"
        ? permissionRaw
        : (() => { throw new Error("--permission must be accept-edits or auto"); })(),
  } : base.execution;
  const workspace = flags.workspace !== undefined
    ? (String(flags.workspace) === "worktree" ? "worktree" : String(flags.workspace) === "checkout" ? "checkout" : (() => { throw new Error("--workspace must be checkout or worktree"); })())
    : base.workspace;
  const initialPrompt = flags["starter-prompt"] !== undefined ? String(flags["starter-prompt"]) : base.initialPrompt;
  const preset = launchPresetSchema.parse({ execution, workspace, initialPrompt });
  if (!preset.execution && !preset.initialPrompt && preset.workspace === "checkout") return null;
  return preset;
}
