import { z } from "zod";
import type { NewThreadComposerProps } from "@get-bb/plugin-sdk/app";

export const FLEET_PERMISSION_MODES = ["accept-edits", "auto"] as const;
export type FleetPermissionMode = (typeof FLEET_PERMISSION_MODES)[number];

export const fleetPermissionModeSchema = z.enum(FLEET_PERMISSION_MODES);

export const LAUNCH_PRESET_FULL_PERMISSION_WARNING =
  "Saved launch preset used full permission mode, which the fleet no longer allows; custom permissions were cleared.";

const executionSchema = z.object({
  providerId: z.string().trim().min(1, "Choose a harness for the preferred model."),
  model: z.string().trim().min(1, "Choose a preferred model."),
  reasoningLevel: z.string().min(1),
  serviceTier: z.string().min(1).optional(),
  permissionMode: fleetPermissionModeSchema.nullable(),
}).strict().nullable();

export const launchPresetSchema = z.object({
  execution: executionSchema,
  workspace: z.enum(["checkout", "worktree"]),
  initialPrompt: z.string().max(8192),
}).strict();

export type LaunchPreset = z.infer<typeof launchPresetSchema>;

function coerceStoredFullPermission(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const preset = value as { execution?: { permissionMode?: string | null } | null };
  if (preset.execution?.permissionMode !== "full") return value;
  return { ...preset, execution: { ...preset.execution, permissionMode: null } };
}

export const launchPresetStoredSchema = z.preprocess(
  coerceStoredFullPermission,
  launchPresetSchema.nullable(),
);

export function parseStoredLaunchPreset(value: unknown): LaunchPreset | null | undefined {
  if (value === null || value === undefined) return value;
  return launchPresetStoredSchema.parse(value);
}

export function launchPresetStorageWarnings(botDataJson: string): string[] {
  try {
    const parsed = JSON.parse(botDataJson) as { launchPreset?: { execution?: { permissionMode?: string } } };
    if (parsed.launchPreset?.execution?.permissionMode === "full") return [LAUNCH_PRESET_FULL_PERMISSION_WARNING];
  } catch { /* ignore malformed rows */ }
  return [];
}

export function emptyLaunchPreset(): LaunchPreset {
  return { execution: null, workspace: "checkout", initialPrompt: "" };
}

// Seeds are captured with the conversation target. The submitted request always
// wins; never apply a saved preset again on the server after the user edits it.
export function launchComposerSeeds(preset: LaunchPreset | null | undefined): Partial<NewThreadComposerProps> {
  if (!preset) return {};
  const execution = preset.execution;
  return {
    ...(preset.initialPrompt ? { initialPrompt: preset.initialPrompt } : {}),
    ...(execution ? {
      defaultProviderId: execution.providerId,
      defaultModel: execution.model,
      defaultReasoningLevel: execution.reasoningLevel,
      ...(execution.serviceTier === undefined ? {} : { defaultServiceTier: execution.serviceTier }),
      ...(execution.permissionMode === null ? {} : { defaultPermissionMode: execution.permissionMode }),
    } : {}),
  };
}
