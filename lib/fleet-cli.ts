import { createHash } from "node:crypto";
import { readFileSync as readFs } from "node:fs";
import type { BbPluginApi, PluginCliContext } from "@get-bb/plugin-sdk";
import type { BotMetadata } from "../contract";
import { avatarSchema } from "../contract";
import type { BotStore } from "./bot-store";
import type { createBotOps } from "./bot-ops";
import { newNodeId, nodePathSegments, nodeDisplayPath, resolveNodePath, type BotNode, type BotNodeMetadata } from "./bot-nodes";
import { listBotCliActivity } from "./bot-cli-activity";
import { botAddress, parentBotLabel, resolveBotSelector, resolveMachine, resolveProject } from "./fleet-resolve";

const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");
const printable = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

export type FleetOps = ReturnType<typeof createBotOps>;

export const FLEET_COMMANDS = [
  { name: "node", summary: "Create and list fleet tree nodes", usage: "bb bots node create|list ..." },
  { name: "show", summary: "Show public bot metadata without private state", usage: "bb bots show <bot> [--json]" },
  { name: "create", summary: "Create a bot in the fleet registry", usage: "bb bots create --name <n> --role <r> --machine <m> ..." },
  { name: "update", summary: "Update bot identity and launch preset fields", usage: "bb bots update <bot> ..." },
  { name: "link", summary: "Link a bot to a project as owner or member", usage: "bb bots link <bot> <project> --as owner|member [--json]" },
  { name: "unlink", summary: "Remove a bot from a project", usage: "bb bots unlink <bot> <project> [--json]" },
  { name: "release", summary: "Release project ownership", usage: "bb bots release <bot> <project> [--json]" },
  { name: "tree", summary: "Print the fleet tree for one app or the whole fleet", usage: "bb bots tree [<app>] [--json]" },
] as const;

type FlagMap = Record<string, string | boolean>;

function parseFlags(argv: string[], allowed: Set<string>, positionalCount: number | "rest") {
  const flags: FlagMap = {};
  const positional: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") { positional.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    if (arg === "--json") { flags.json = true; continue; }
    if (seen.has(arg)) throw new Error(`Repeated option: ${arg}`);
    seen.add(arg);
    if (!allowed.has(arg)) throw new Error(`Unknown option: ${arg}`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    flags[arg.slice(2)] = value;
  }
  if (positionalCount !== "rest" && positional.length !== positionalCount) throw new Error("Unexpected arguments");
  return { flags, positional, json: Boolean(flags.json) };
}

function readSoul(flags: FlagMap, cwd: string) {
  if (typeof flags.soul === "string") return flags.soul;
  if (typeof flags["soul-file"] === "string") {
    const path = flags["soul-file"].startsWith("/") ? flags["soul-file"] : `${cwd}/${flags["soul-file"]}`;
    const content = readFs(path, "utf8");
    if (content.length > 4096) throw new Error("SOUL exceeds 4096 characters");
    return content;
  }
  throw new Error("Provide --soul or --soul-file");
}

function defaultAvatar() {
  return avatarSchema.parse({ color: "#168b75", shape: "round", expression: "curious", motion: "still" });
}

async function machineId(bb: BbPluginApi, selector: string) {
  return (await resolveMachine(bb, selector)).id;
}

export async function runFleetCommand(command: string, argv: string[], ctx: PluginCliContext, bb: BbPluginApi, store: BotStore, ops: FleetOps, resolveOwner: (threadId: string, persist?: boolean) => Promise<string | null>): Promise<{ exitCode: number; stdout?: string; stderr?: string }> {
  try {
    if (command === "node") return await runNode(argv, ctx, bb, store);
    if (command === "show") return await runShow(argv, ctx, bb, store, resolveOwner);
    if (command === "create") return await runCreate(argv, ctx, bb, store, ops);
    if (command === "update") return await runUpdate(argv, ctx, bb, store, ops);
    if (command === "link") return await runLink(argv, ctx, bb, store, ops, "link");
    if (command === "unlink") return await runLink(argv, ctx, bb, store, ops, "unlink");
    if (command === "release") return await runLink(argv, ctx, bb, store, ops, "release");
    if (command === "tree") return await runTree(argv, ctx, store);
    throw new Error(`Unknown fleet command: ${command}`);
  } catch (error) {
    return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
  }
}

async function runNode(argv: string[], ctx: PluginCliContext, bb: BbPluginApi, store: BotStore) {
  const sub = argv[0];
  if (!sub || sub === "--help") throw new Error("Usage: bb bots node create <path> ... | bb bots node list [<app>] [--json]");
  if (sub === "create") {
    const { flags, positional, json } = parseFlags(argv.slice(1), new Set(["--kind", "--project", "--data-service-path", "--database", "--folded-into", "--json"]), 1);
    const path = positional[0]!;
    const kind = String(flags.kind ?? "");
    if (kind !== "app" && kind !== "schema") throw new Error("--kind must be app or schema");
    const parts = nodePathSegments(path);
    const nodes = store.nodes.list();
    if (kind === "app") {
      if (parts.length !== 1) throw new Error("App node path must be a single name");
      if (store.nodes.findByParentAndName(null, parts[0]!)) throw new Error(`App node already exists: ${parts[0]}`);
      const projectId = flags.project ? (await resolveProject(bb, String(flags.project))).id : null;
      const node: BotNode = { id: newNodeId(), kind: "app", name: parts[0]!, parentNodeId: null, projectId, sectionId: null, metadata: {}, createdAt: Date.now() };
      store.nodes.save(node);
      const out = { node, created: true };
      return { exitCode: 0, stdout: json ? JSON.stringify(out) : `Created app node ${node.name} (${node.id})` };
    }
    if (parts.length !== 2) throw new Error("Schema node path must be <app>/<schema>");
    const app = resolveNodePath(nodes, parts[0]!);
    if (app.kind !== "app") throw new Error("Parent must be an app node");
    if (store.nodes.findByParentAndName(app.id, parts[1]!)) throw new Error(`Schema node already exists: ${path}`);
    const metadata: BotNodeMetadata = {};
    if (flags["data-service-path"]) metadata.dataServicePath = String(flags["data-service-path"]);
    if (flags.database) metadata.database = String(flags.database);
    if (flags["folded-into"]) metadata.foldedInto = String(flags["folded-into"]);
    const node: BotNode = { id: newNodeId(), kind: "schema", name: parts[1]!, parentNodeId: app.id, projectId: null, sectionId: null, metadata, createdAt: Date.now() };
    store.nodes.save(node);
    const out = { node, created: true };
    return { exitCode: 0, stdout: json ? JSON.stringify(out) : `Created schema node ${path} (${node.id})` };
  }
  if (sub === "list") {
    const { flags, positional, json } = parseFlags(argv.slice(1), new Set(["--json"]), "rest");
    const filter = positional[0];
    let nodes = store.nodes.list();
    if (filter) {
      const app = resolveNodePath(nodes, filter);
      nodes = nodes.filter((node) => node.id === app.id || node.parentNodeId === app.id);
    }
    const rows = nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      path: nodeDisplayPath(nodes, node.id),
      projectId: node.projectId,
      metadata: node.metadata,
    }));
    if (json) return { exitCode: 0, stdout: JSON.stringify({ nodes: rows }) };
    return { exitCode: 0, stdout: ["PATH\tKIND\tID", ...rows.map((row) => [row.path, row.kind, row.id].join("\t"))].join("\n") };
  }
  throw new Error(`Unknown node command: ${sub}`);
}

async function runShow(argv: string[], ctx: PluginCliContext, bb: BbPluginApi, store: BotStore, resolveOwner: (threadId: string, persist?: boolean) => Promise<string | null>) {
  const { flags, positional, json } = parseFlags(argv, new Set(["--json"]), 1);
  const bot = resolveBotSelector(store, positional[0]!);
  const nodes = store.nodes.list();
  const hosts = await bb.sdk.hosts.list();
  const host = hosts.find((entry) => entry.id === bot.hostId);
  const projects = new Map((await bb.sdk.projects.list()).map((project) => [project.id, project.name]));
  const owned = store.ownedProjects(bot.id);
  const parent = parentBotLabel(store, bot);
  const section = bot.sectionId ? store.sections().find((entry) => entry.id === bot.sectionId)?.name ?? null : null;
  const { activity, firstThreads } = await listBotCliActivity(bb, store, resolveOwner, ctx);
  const mainThreadId = firstThreads.get(bot.id) ?? null;
  const payload = {
    id: bot.id,
    name: botAddress(nodes, bot),
    role: bot.role,
    machine: host ? { id: host.id, name: host.name } : { id: bot.hostId, name: "Unavailable machine" },
    parent,
    section,
    soul: { chars: bot.soul.length, sha256: sha256(bot.soul) },
    memory: { chars: bot.memory.length, max: 3000 },
    launchPreset: bot.launchPreset ?? null,
    projects: bot.linkedProjectIds.map((id) => ({ id, name: projects.get(id) ?? "Unavailable project", role: owned.includes(id) ? "owner" as const : "member" as const })),
    main: mainThreadId ? { threadId: mainThreadId, projectId: null, archived: false } : null,
    status: activity.get(bot.id) ?? "idle",
    nodePath: nodeDisplayPath(nodes, bot.nodeId ?? null),
    parentBotId: bot.parentBotId ?? null,
    parentName: parent?.name ?? null,
  };
  if (json) return { exitCode: 0, stdout: JSON.stringify(payload) };
  return { exitCode: 0, stdout: [
    `Address: ${payload.name}`,
    `Role: ${printable(bot.role)}`,
    `Machine: ${payload.machine.name}`,
    `Section: ${section ?? "—"}`,
    `Parent: ${parent?.name ?? "—"}`,
    `Projects: ${payload.projects.map((project) => `${project.name} (${project.role})`).join(", ") || "—"}`,
  ].join("\n") };
}

async function runCreate(argv: string[], ctx: PluginCliContext, bb: BbPluginApi, store: BotStore, ops: FleetOps) {
  const { flags, json } = parseFlags(argv, new Set(["--name", "--role", "--machine", "--soul", "--soul-file", "--node", "--parent", "--project", "--as", "--section", "--json"]), "rest");
  const name = String(flags.name ?? "");
  const role = String(flags.role ?? "");
  if (!name || !role) throw new Error("--name and --role are required");
  const soul = readSoul(flags, ctx.cwd ?? "/");
  const hostId = await machineId(bb, String(flags.machine ?? ""));
  let nodeId: string | null = null;
  if (flags.node) {
    nodeId = resolveNodePath(store.nodes.list(), String(flags.node)).id;
  }
  let parentBotId: string | null = null;
  if (flags.parent) parentBotId = resolveBotSelector(store, String(flags.parent)).id;
  let linkedProjectIds: string[] = [];
  let ownedProjectIds: string[] | undefined;
  if (flags.project) {
    const project = await resolveProject(bb, String(flags.project));
    linkedProjectIds = [project.id];
    if (flags.as === "owner") ownedProjectIds = [project.id];
    else if (flags.as === "member" || !flags.as) linkedProjectIds = [project.id];
    else throw new Error("--as must be owner or member");
  }
  let sectionId: string | null = null;
  if (flags.section) {
    const name = String(flags.section);
    const existing = store.sections().find((section) => section.name === name);
    if (!existing) throw new Error(`Section not found: ${name}`);
    sectionId = existing.id;
  }
  const created = await ops.createBot({ name, role, hostId, avatar: defaultAvatar(), sectionId, linkedProjectIds, ownedProjectIds, soul, nodeId, parentBotId });
  const out = { bot: created, address: botAddress(store.nodes.list(), created) };
  return { exitCode: 0, stdout: json ? JSON.stringify(out) : `Created ${out.address} (${created.id})` };
}

async function runUpdate(argv: string[], ctx: PluginCliContext, bb: BbPluginApi, store: BotStore, ops: FleetOps) {
  const { flags, positional, json } = parseFlags(argv, new Set(["--name", "--role", "--soul", "--soul-file", "--machine", "--parent", "--no-parent", "--section", "--no-section", "--json"]), 1);
  const bot = resolveBotSelector(store, positional[0]!);
  const hasUpdateFlag = Boolean(
    flags.name || flags.role || flags.soul || flags["soul-file"] || flags.machine ||
    flags.parent || flags["no-parent"] || flags.section || flags["no-section"],
  );
  const patch: Partial<{ name: string; role: string; soul: string; hostId: string; sectionId: string | null; parentBotId: string | null }> = {};
  if (flags.name) patch.name = String(flags.name);
  if (flags.role) patch.role = String(flags.role);
  if (flags.soul || flags["soul-file"]) {
    const soul = readSoul(flags, ctx.cwd ?? "/");
    if (sha256(soul) !== sha256(bot.soul)) patch.soul = soul;
  }
  if (flags.machine) patch.hostId = await machineId(bb, String(flags.machine));
  if (flags["no-parent"]) patch.parentBotId = null;
  else if (flags.parent) patch.parentBotId = resolveBotSelector(store, String(flags.parent)).id;
  if (flags["no-section"]) patch.sectionId = null;
  else if (flags.section) {
    const section = store.sections().find((entry) => entry.name === String(flags.section));
    if (!section) throw new Error(`Section not found: ${flags.section}`);
    patch.sectionId = section.id;
  }
  if (!Object.keys(patch).length) {
    if (!hasUpdateFlag) throw new Error("Provide at least one field to update");
    return { exitCode: 0, stdout: json ? JSON.stringify({ bot, unchanged: true }) : "unchanged" };
  }
  const updated = await ops.updateBot(bot.id, patch);
  const out = { bot: updated, address: botAddress(store.nodes.list(), updated) };
  return { exitCode: 0, stdout: json ? JSON.stringify(out) : `Updated ${out.address}` };
}

async function runLink(argv: string[], _ctx: PluginCliContext, bb: BbPluginApi, store: BotStore, ops: FleetOps, mode: "link" | "unlink" | "release") {
  const { flags, positional, json } = parseFlags(argv, new Set(["--as", "--json"]), 2);
  const bot = resolveBotSelector(store, positional[0]!);
  const project = await resolveProject(bb, positional[1]!);
  let action: "join" | "leave" | "own" | "release";
  if (mode === "unlink") action = "leave";
  else if (mode === "release") action = "release";
  else {
    const as = String(flags.as ?? "");
    if (as !== "owner" && as !== "member") throw new Error("link requires --as owner|member");
    action = as === "owner" ? "own" : "join";
  }
  const result = await ops.updateProjectRole(bot.id, action, project.id);
  const out = { botId: bot.id, projectId: project.id, action, changed: result.changed };
  return { exitCode: 0, stdout: json ? JSON.stringify(out) : `${action} ${project.name}${result.changed ? "" : " (unchanged)"}` };
}

async function runTree(argv: string[], _ctx: PluginCliContext, store: BotStore) {
  const { flags, positional, json } = parseFlags(argv, new Set(["--json"]), "rest");
  const filter = positional[0];
  const nodes = store.nodes.list();
  const bots = store.list();
  const apps = nodes.filter((node) => node.kind === "app" && !node.parentNodeId);
  let selected = apps;
  if (filter) {
    const byName = apps.filter((app) => app.name === filter);
    if (byName.length) selected = byName;
    else {
      let filterAppId: string;
      try {
        filterAppId = resolveNodePath(nodes, filter).id;
      } catch {
        throw new Error(`App not found: ${filter}`);
      }
      selected = apps.filter((app) => app.id === filterAppId);
    }
    if (!selected.length) throw new Error(`App not found: ${filter}`);
  }
  const blocks = selected.map((app) => formatAppTree(app, nodes, bots));
  const shared = bots.filter((bot) => !(bot.nodeId ?? null));
  const payload = { apps: blocks, shared: shared.map((bot) => ({ id: bot.id, name: bot.name, address: bot.name })) };
  if (json) return { exitCode: 0, stdout: JSON.stringify(payload) };
  const lines = [...blocks.flatMap((block) => block.lines), "fleet:", ...shared.map((bot) => `  ${bot.name}`)];
  return { exitCode: 0, stdout: lines.join("\n") };
}

function formatAppTree(app: BotNode, nodes: BotNode[], bots: BotMetadata[]) {
  const appBots = bots.filter((bot) => (bot.nodeId ?? null) === app.id);
  const roots = appBots.filter((bot) => !(bot.parentBotId ?? null));
  const members = appBots.filter((bot) => bot.parentBotId);
  const schemas = nodes.filter((node) => node.parentNodeId === app.id && node.kind === "schema");
  const lines = [`${app.name}${app.projectId ? ` (project ${app.projectId})` : ""}`];
  for (const root of roots) lines.push(`  ${botAddress(nodes, root)}`);
  for (const member of members) {
    const parent = member.parentBotId ? bots.find((bot) => bot.id === member.parentBotId) : null;
    const parentLabel = parent ? botAddress(nodes, parent) : "(missing)";
    lines.push(`    ${botAddress(nodes, member)} (parent ${parentLabel})`);
  }
  for (const schema of schemas) {
    const path = `${app.name}/${schema.name}`;
    const schemaBots = bots.filter((bot) => bot.nodeId === schema.id);
    if (schema.metadata.foldedInto) lines.push(`    ${path} (folded into ${schema.metadata.foldedInto})`);
    else {
      for (const bot of schemaBots) lines.push(`    ${botAddress(nodes, bot)}`);
      if (!schemaBots.some((bot) => bot.name === "data")) lines.push(`    ${path}/data (missing)`);
    }
  }
  return { app: app.name, lines };
}

export function listRowExtras(store: BotStore, bot: BotMetadata) {
  const nodes = store.nodes.list();
  const address = botAddress(nodes, bot);
  const parent = parentBotLabel(store, bot);
  return {
    address,
    nodePath: nodeDisplayPath(nodes, bot.nodeId ?? null),
    parentBotId: bot.parentBotId ?? null,
    parentName: parent?.name ?? null,
  };
}
