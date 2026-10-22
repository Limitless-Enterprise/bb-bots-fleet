import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { BotMetadata } from "../contract";
import type { BotStore } from "./bot-store";
import { nodeDisplayPath, resolveNodePath, type BotNode } from "./bot-nodes";

export function botAddress(nodes: BotNode[], bot: BotMetadata): string {
  const path = nodeDisplayPath(nodes, bot.nodeId ?? null);
  return path ? `${path}/${bot.name}` : bot.name;
}

export function resolveBotSelector(store: BotStore, selector: string): BotMetadata {
  const bots = store.list();
  const nodes = store.nodes.list();
  const byId = bots.find((bot) => bot.id === selector);
  if (byId) return byId;
  if (selector.includes("/")) {
    try {
      const slash = selector.lastIndexOf("/");
      const nodePath = selector.slice(0, slash);
      const name = selector.slice(slash + 1);
      if (!name) throw new Error(`Invalid bot address: ${selector}`);
      const resolved = resolveNodePath(nodes, nodePath);
      const match = bots.find((bot) => (bot.nodeId ?? null) === resolved.id && bot.name === name);
      if (!match) throw new Error(`Bot not found: ${selector}`);
      return match;
    } catch (error) {
      const legacy = bots.filter((bot) => bot.name === selector);
      if (legacy.length === 1) return legacy[0]!;
      if (legacy.length > 1) throw new Error("Several bots have that legacy slash name. Use a bot id.");
      throw error;
    }
  }
  const shared = bots.filter((bot) => !(bot.nodeId ?? null) && bot.name === selector);
  if (shared.length === 1) return shared[0]!;
  if (shared.length > 1) throw new Error("Several shared bots have that name. Use a full address or bot id.");
  const addressed = bots.filter((bot) => botAddress(nodes, bot) === selector);
  if (addressed.length === 1) return addressed[0]!;
  if (addressed.length > 1) throw new Error("Ambiguous bot address. Use a bot id.");
  const partial = bots.filter((bot) => (bot.nodeId ?? null) && bot.name === selector);
  if (partial.length > 1) {
    throw new Error(`Ambiguous bot name "${selector}". Matches: ${partial.map((bot) => botAddress(nodes, bot)).join(", ")}`);
  }
  if (partial.length === 1) return partial[0]!;
  throw new Error("Bot not found. Use bb bots list for ids and addresses.");
}

export async function resolveProject(bb: BbPluginApi, selector: string) {
  if (selector === "personal") {
    const personal = (await bb.sdk.projects.list({ includePersonal: true })).find((project) => project.kind === "personal");
    if (!personal) throw new Error("Personal project is unavailable");
    return personal;
  }
  const projects = (await bb.sdk.projects.list()).filter((project) => project.kind === "standard");
  const byId = projects.find((project) => project.id === selector);
  if (byId) return byId;
  const byName = projects.filter((project) => project.name === selector);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) throw new Error(`Ambiguous project name "${selector}": ${byName.map((project) => project.id).join(", ")}`);
  throw new Error(`Project not found: ${selector}`);
}

export async function resolveMachine(bb: BbPluginApi, selector: string) {
  const hosts = await bb.sdk.hosts.list();
  const byId = hosts.find((host) => host.id === selector);
  if (byId) return byId;
  const byName = hosts.filter((host) => host.name === selector);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) throw new Error(`Ambiguous machine name "${selector}": ${byName.map((host) => host.id).join(", ")}`);
  throw new Error(`Machine not found: ${selector}`);
}

export function parentBotLabel(store: BotStore, bot: BotMetadata): { id: string; name: string } | null {
  const parentId = bot.parentBotId ?? null;
  if (!parentId) return null;
  const parent = store.get(parentId);
  if (!parent) return null;
  const nodes = store.nodes.list();
  return { id: parent.id, name: botAddress(nodes, parent) };
}
