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
  if (!parts.length || parts.some((part) => part.length > 120)) throw new Error("Invalid node path");
  return parts;
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

export function validateBotRegistry(nodes: BotNode[], bots: BotMetadata[]) {
  const appNames = new Set(nodes.filter((node) => node.kind === "app" && !node.parentNodeId).map((node) => node.name));
  const keyed = new Map<string, BotMetadata>();
  for (const bot of bots) {
    const nodeId = bot.nodeId ?? null;
    const key = nodeId ? `${nodeId}\0${bot.name}` : `\0shared\0${bot.name}`;
    if (keyed.has(key)) throw new Error(`Duplicate bot address: ${bot.name}`);
    keyed.set(key, bot);
    if (!nodeId && appNames.has(bot.name)) throw new Error(`Shared bot name collides with app node: ${bot.name}`);
  }
}

export function newNodeId() {
  return `node_${randomUUID().replaceAll("-", "")}`;
}
