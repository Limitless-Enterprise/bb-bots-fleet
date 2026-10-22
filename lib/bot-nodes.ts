import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { BotMetadata } from "../contract";
import type { BotStore } from "./bot-store";

export const nodeKindSchema = z.enum(["app", "schema"]);
export type BotNodeKind = z.infer<typeof nodeKindSchema>;

export const nodeMetadataSchema = z.object({
  dataServicePath: z.string().optional(),
  database: z.string().optional(),
  registryRef: z.string().optional(),
  foldedInto: z.string().optional(),
}).strict();

export type BotNodeMetadata = z.infer<typeof nodeMetadataSchema>;

export const botNodeSchema = z.object({
  id: z.string().min(1),
  kind: nodeKindSchema,
  name: z.string().min(1).max(120),
  parentNodeId: z.string().nullable(),
  projectId: z.string().nullable(),
  sectionId: z.string().nullable(),
  metadata: nodeMetadataSchema,
  createdAt: z.number().int().nonnegative(),
}).strict();

export type BotNode = z.infer<typeof botNodeSchema>;

export function createBotNodeStore(db: import("better-sqlite3").Database) {
  const rowToNode = (row: { id: string; kind: string; name: string; parent_node_id: string | null; project_id: string | null; section_id: string | null; metadata: string; created_at: number }) =>
    botNodeSchema.parse({
      id: row.id,
      kind: row.kind,
      name: row.name,
      parentNodeId: row.parent_node_id,
      projectId: row.project_id,
      sectionId: row.section_id,
      metadata: JSON.parse(row.metadata || "{}"),
      createdAt: row.created_at,
    });

  const list = (): BotNode[] =>
    (db.prepare("SELECT id, kind, name, parent_node_id, project_id, section_id, metadata, created_at FROM bot_nodes ORDER BY created_at, id").all() as Parameters<typeof rowToNode>[0][]).map(rowToNode);

  const get = (id: string): BotNode | null => {
    const row = db.prepare("SELECT id, kind, name, parent_node_id, project_id, section_id, metadata, created_at FROM bot_nodes WHERE id = ?").get(id) as Parameters<typeof rowToNode>[0] | undefined;
    return row ? rowToNode(row) : null;
  };

  const findByParentAndName = (parentNodeId: string | null, name: string) => {
    const row = (parentNodeId === null
      ? db.prepare("SELECT id, kind, name, parent_node_id, project_id, section_id, metadata, created_at FROM bot_nodes WHERE parent_node_id IS NULL AND name = ?").get(name)
      : db.prepare("SELECT id, kind, name, parent_node_id, project_id, section_id, metadata, created_at FROM bot_nodes WHERE parent_node_id = ? AND name = ?").get(parentNodeId, name)) as Parameters<typeof rowToNode>[0] | undefined;
    return row ? rowToNode(row) : null;
  };

  const save = (node: BotNode) => {
    const value = botNodeSchema.parse(node);
    const conflict = findByParentAndName(value.parentNodeId, value.name);
    if (conflict && conflict.id !== value.id) throw new Error(`Node already exists: ${value.name}`);
    db.prepare(
      "INSERT INTO bot_nodes(id, kind, name, parent_node_id, project_id, section_id, metadata, created_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, name=excluded.name, parent_node_id=excluded.parent_node_id, project_id=excluded.project_id, section_id=excluded.section_id, metadata=excluded.metadata",
    ).run(value.id, value.kind, value.name, value.parentNodeId, value.projectId, value.sectionId, JSON.stringify(value.metadata), value.createdAt);
    return value;
  };

  return { list, get, findByParentAndName, save };
}

export function nodePathSegments(path: string): string[] {
  const trimmed = path.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) throw new Error("Node path is required");
  const parts = trimmed.split("/").map((part) => part.trim()).filter(Boolean);
  if (!parts.length || parts.some((part) => part.length > 120 || part.includes("/"))) throw new Error("Invalid node path");
  return parts;
}

export function appNodeIdForBot(nodes: BotNode[], bot: Pick<BotMetadata, "nodeId">): string | null {
  if (!bot.nodeId) return null;
  let current = nodes.find((node) => node.id === bot.nodeId) ?? null;
  while (current?.parentNodeId) current = nodes.find((node) => node.id === current!.parentNodeId) ?? null;
  return current?.kind === "app" ? current.id : null;
}

export function resolveNodePath(nodes: BotNode[], path: string): BotNode {
  const parts = nodePathSegments(path);
  let parentId: string | null = null;
  let current: BotNode | null = null;
  for (const name of parts) {
    current = nodes.find((node) => node.parentNodeId === parentId && node.name === name) ?? null;
    if (!current) throw new Error(`Node not found: ${path}`);
    parentId = current.id;
  }
  return current!;
}

export function nodeDisplayPath(nodes: BotNode[], nodeId: string | null | undefined): string | null {
  if (!nodeId) return null;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const segments: string[] = [];
  let current = byId.get(nodeId);
  while (current) {
    segments.unshift(current.name);
    current = current.parentNodeId ? byId.get(current.parentNodeId) ?? undefined : undefined;
  }
  return segments.length ? segments.join("/") : null;
}

/** Validates one bot on save; legacy duplicate shared names and slash names are left untouched until renamed. */
export function validateBotSave(nodes: BotNode[], bot: BotMetadata, peers: BotMetadata[], previous: BotMetadata | null) {
  const nameChanged = !previous || previous.name !== bot.name;
  const nodeChanged = !previous || (previous.nodeId ?? null) !== (bot.nodeId ?? null);
  if (nameChanged && bot.name.includes("/")) throw new Error("Bot name must not contain '/'");
  const appNames = new Set(nodes.filter((node) => node.kind === "app" && !node.parentNodeId).map((node) => node.name));
  const nodeId = bot.nodeId ?? null;
  if (nodeId) {
    const node = nodes.find((entry) => entry.id === nodeId);
    if (!node) throw new Error(`Node not found for bot: ${bot.name}`);
    validateBotPlacement(nodes, bot, peers, node);
    if (node.kind === "app") {
      const unparented = !(bot.parentBotId ?? null);
      const wasUnparentedLead = previous && !(previous.parentBotId ?? null) && (previous.nodeId ?? null) === nodeId;
      const hadParent = previous?.parentBotId ?? null;
      if (hadParent && !(bot.parentBotId ?? null)) {
        throw new Error("Cannot remove parent from an app member bot");
      }
      if (wasUnparentedLead && nameChanged && previous!.name === "lead" && bot.name !== "lead") {
        throw new Error("App lead bot cannot be renamed");
      }
      if (unparented) {
        if (bot.name !== "lead") {
          throw new Error("Unparented app-node bot must be named lead; members must use --parent <app>/lead");
        }
        const existingLead = peers.find((peer) => (peer.nodeId ?? null) === nodeId && !(peer.parentBotId ?? null));
        if (existingLead) throw new Error("App node already has a lead bot; members must use --parent <app>/lead");
      }
    }
    if (nameChanged || nodeChanged) {
      if (peers.some((peer) => (peer.nodeId ?? null) === nodeId && peer.name === bot.name)) {
        throw new Error(`Duplicate bot address: ${bot.name}`);
      }
    }
  } else {
    if (appNames.has(bot.name)) throw new Error(`Shared bot name collides with app node: ${bot.name}`);
    if (bot.parentBotId ?? null) throw new Error("Shared bots cannot have a parent bot");
    if (nameChanged || nodeChanged) {
      if (peers.some((peer) => !(peer.nodeId ?? null) && peer.name === bot.name)) {
        throw new Error(`Duplicate shared bot name: ${bot.name}`);
      }
    }
  }
  const parentId = bot.parentBotId ?? null;
  if (!parentId) return;
  if (parentId === bot.id) throw new Error("Bot cannot be its own parent");
  const parent = peers.find((peer) => peer.id === parentId) ?? null;
  if (!parent) throw new Error(`Parent bot not found: ${parentId}`);
  if (parent.parentBotId ?? null) throw new Error("Parent must be the app lead");
  const childApp = appNodeIdForBot(nodes, bot);
  const parentApp = appNodeIdForBot(nodes, parent);
  if (!childApp || !parentApp || childApp !== parentApp) throw new Error("Member parent must be the lead of the same app");
  let walk: string | null = parentId;
  const byId = new Map([...peers, bot].map((entry) => [entry.id, entry]));
  while (walk) {
    if (walk === bot.id) throw new Error("Bot parent chain cannot cycle");
    walk = byId.get(walk)?.parentBotId ?? null;
  }
}

function validateBotPlacement(nodes: BotNode[], bot: BotMetadata, peers: BotMetadata[], node: BotNode) {
  if (node.kind === "schema" && node.metadata.foldedInto) {
    throw new Error(`Schema node is folded into ${node.metadata.foldedInto}; bots cannot be attached here`);
  }
  if (node.kind === "schema" && bot.name !== "data") {
    throw new Error("Only data bots may be attached to a schema node");
  }
  if (node.kind === "schema" && bot.name === "data") {
    const existing = peers.find((peer) => (peer.nodeId ?? null) === node.id && peer.name === "data");
    if (existing) throw new Error("Schema node already has a data bot");
  }
}

export function assertAppNodeNameAvailable(nodes: BotNode[], bots: BotMetadata[], appName: string) {
  if (bots.some((bot) => !(bot.nodeId ?? null) && bot.name === appName)) {
    throw new Error(`Shared bot name collides with app node: ${appName}`);
  }
  if (nodes.some((node) => node.kind === "app" && !node.parentNodeId && node.name === appName)) {
    throw new Error(`App node already exists: ${appName}`);
  }
}

export function validateSchemaNodeMetadata(nodes: BotNode[], app: BotNode, metadata: BotNodeMetadata) {
  if (metadata.foldedInto && (metadata.dataServicePath || metadata.database)) {
    throw new Error("Schema node cannot set folded-into together with data-service-path or database");
  }
}

export function validateFoldedIntoAddress(nodes: BotNode[], bots: BotMetadata[], app: BotNode, foldedInto: string) {
  const matches = bots.filter((bot) => {
    const path = nodeDisplayPath(nodes, bot.nodeId ?? null);
    return (path ? `${path}/${bot.name}` : bot.name) === foldedInto;
  });
  if (matches.length !== 1) throw new Error(`folded-into target not found: ${foldedInto}`);
  const suffix = foldedInto.slice(app.name.length + 1);
  if (!foldedInto.startsWith(`${app.name}/`) || (suffix !== "api" && suffix !== "builder")) {
    throw new Error("folded-into must name an existing <app>/api or <app>/builder bot");
  }
}

export function newNodeId() {
  return `node_${randomUUID().replaceAll("-", "")}`;
}
