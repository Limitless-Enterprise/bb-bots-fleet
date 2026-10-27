import type { BbPluginApi } from "@get-bb/plugin-sdk";

export const RESERVED_PROJECT_IDS_SETTING_KEY = "reservedProjectIds";

export const fleetReservedProjectSettings = {
  [RESERVED_PROJECT_IDS_SETTING_KEY]: {
    type: "string" as const,
    label: "Reserved project IDs",
    description: "Comma- or newline-separated BB project IDs that bots may not own or bind (for example the CTO coordination project).",
    experimental_multiline: true,
    default: "",
  },
};

export function parseReservedProjectIds(raw: string | undefined): Set<string> {
  if (!raw?.trim()) return new Set();
  return new Set(raw.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean));
}

let cachedReservedRaw = "";

export async function initFleetReservedProjectSettings(bb: BbPluginApi) {
  const handle = bb.settings.define(fleetReservedProjectSettings);
  const apply = (raw: string) => {
    cachedReservedRaw = raw;
  };
  handle.onChange((next) => apply(next.reservedProjectIds ?? ""));
  apply((await handle.get()).reservedProjectIds ?? "");
}

export function getReservedProjectIds(_bb?: BbPluginApi): Set<string> {
  return parseReservedProjectIds(cachedReservedRaw);
}

export function assertFleetProjectAllowed(projectId: string, reserved: Set<string>, action: "own" | "bind") {
  if (!reserved.has(projectId)) return;
  throw new Error(`Bots cannot ${action === "own" ? "own" : "bind to"} reserved project ${projectId}`);
}
