import type { BotMetadata } from "../contract";
import type { BotStore } from "./bot-store";
import type { FleetOps } from "./fleet-cli";

export const FLEET_SECTION_NAME = "FLEET";
export const SHARED_SECTION_NAME = "SHARED";

export const FLEET_GLOBAL_BOT_NAMES = new Set(["cto", "fleet", "guidelines", "incident"]);
export const SHARED_SPECIALIST_BOT_NAMES = new Set([
  "architect",
  "reviewer",
  "qa",
  "release",
  "docs",
  "security",
  "schema",
  "platform",
]);

export function sectionNameForBot(botName: string, appSectionName: string): string | null {
  if (FLEET_GLOBAL_BOT_NAMES.has(botName)) return FLEET_SECTION_NAME;
  if (SHARED_SPECIALIST_BOT_NAMES.has(botName)) return SHARED_SECTION_NAME;
  return appSectionName;
}

export async function ensureNamedSection(
  store: BotStore,
  ops: FleetOps,
  name: string,
  dryRun: boolean,
): Promise<{ id: string | null; created: boolean }> {
  const existing = store.sections().find((section) => section.name === name);
  if (existing) return { id: existing.id, created: false };
  if (dryRun) return { id: null, created: true };
  const created = await ops.createSection(name);
  return { id: created.id, created: true };
}

/** Assign section when empty or already on the target section; never override operator placement elsewhere. */
export function sectionAssignmentPlan(
  bot: BotMetadata,
  targetSectionName: string,
  store: BotStore,
): "assign" | "unchanged" | "blocked" {
  const target = store.sections().find((section) => section.name === targetSectionName);
  if (!target) return "unchanged";
  if (!bot.sectionId) return "assign";
  if (bot.sectionId === target.id) return "unchanged";
  const current = store.sections().find((section) => section.id === bot.sectionId)?.name ?? null;
  if (current === targetSectionName) return "unchanged";
  return "blocked";
}
