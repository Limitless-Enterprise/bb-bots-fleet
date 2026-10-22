import type { PluginCliContext } from "@get-bb/plugin-sdk";
import type { BotMetadata } from "../contract";

/** Shared fleet steward bot (`agents/fleet/SOUL.md`); sole thread caller allowed to mutate registry SOULs. */
export function isFleetSteward(bot: BotMetadata | null | undefined): boolean {
  return Boolean(bot && !(bot.nodeId ?? null) && bot.name === "fleet");
}

export function assertFleetRegistryOperator(ctx: PluginCliContext, callerBot: BotMetadata | null) {
  if (!ctx.threadId) return;
  if (isFleetSteward(callerBot)) return;
  throw new Error("Fleet registry commands are operator-only and cannot run from a BB thread unless the caller is the fleet steward bot");
}

export function assertFleetSoulMutationFromThread(ctx: PluginCliContext, callerBot: BotMetadata | null, changingSoul: boolean) {
  if (!changingSoul || !ctx.threadId) return;
  if (isFleetSteward(callerBot)) return;
  throw new Error("SOUL changes require the fleet steward bot or an operator shell");
}
