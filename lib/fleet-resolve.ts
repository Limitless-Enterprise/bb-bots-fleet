import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { BotMetadata } from "../contract";
import type { BotStore } from "./bot-store";
import { nodeDisplayPath, type BotNode } from "./bot-nodes";

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
    const slash = selector.lastIndexOf("/");
    const nodePath = selector.slice(0, slash);
    const name = selector.slice(slash + 1);
    if (!name) throw new Error(`Invalid bot address: ${selector}`);
    const node = store.nodes.list();
    const resolved = resolveNodeByPath(node, nodePath);
    const match = bots.find((bot) => (bot.nodeId ?? null) === resolved.id && bot.name === name);
    if (!match) throw new Error(`Bot not found: ${selector}`);
    return match;
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
  throw new Error("Bot not found. Use bb bots list for ids and addresses.");
}

function resolveNodeByPath(nodes: BotNode[], path: string): BotNode {
  const parts = path.split("/").filter(Boolean);
  let parentId: string | null = null;
  let current: BotNode | null = null;
  for (const name of parts) {
    current = nodes.find((node) => node.parentNodeId === parentId && node.name === name) ?? null;
    if (!current) throw new Error(`Node not found: ${path}`);
    parentId = current.id;
  }
  if (!current) throw new Error(`Node not found: ${path}`);
  return current;
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
