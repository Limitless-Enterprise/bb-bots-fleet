import { readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { LaunchPreset } from "./launch-preset";
import { launchPresetSchema } from "./launch-preset";

const launchBlockSchema = z.object({
  provider: z.string().optional(),
  providerId: z.string().optional(),
  model: z.string().min(1).optional(),
  reasoning: z.string().optional(),
  reasoningLevel: z.string().optional(),
  permission: z.enum(["accept-edits", "auto", "full"]).optional(),
  permissionMode: z.enum(["accept-edits", "auto", "full"]).optional(),
  workspace: z.enum(["checkout", "worktree"]).optional(),
  serviceTier: z.string().optional(),
  "service-tier": z.string().optional(),
}).strict().partial();

const botSpecSchema = z.object({
  role: z.string().min(1),
  soulFile: z.string().optional(),
  soul: z.string().optional(),
  parent: z.string().optional(),
  projectRole: z.enum(["owner", "member"]).optional(),
  launch: launchBlockSchema.optional(),
  execution: launchBlockSchema.optional(),
  main: z.boolean().optional(),
}).strict();

const schemaSpecSchema = z.object({
  dataServicePath: z.string().optional(),
  database: z.string().optional(),
  data: z.union([botSpecSchema.extend({ foldedInto: z.string().optional() }), z.object({ foldedInto: z.string() })]).optional(),
  foldedInto: z.string().optional(),
}).strict();

const rawManifestSchema = z.object({
  version: z.number().int().optional(),
  app: z.union([z.string(), z.object({ bbProject: z.string().optional(), machine: z.string().optional() }).strict()]).optional(),
  team: z.string().optional(),
  project: z.string().optional(),
  defaults: z.object({ machine: z.string().optional(), launch: launchBlockSchema.optional(), execution: launchBlockSchema.optional() }).strict().optional(),
  bots: z.record(z.string(), botSpecSchema).default({}),
  schemas: z.record(z.string(), schemaSpecSchema).default({}),
  specialists: z.array(z.string()).default([]),
  charter: z.object({ to: z.string(), messageFile: z.string() }).strict().optional(),
}).strict();

export type NormalizedBotSpec = {
  key: string;
  role: string;
  soulPath: string;
  parentKey: string | null;
  projectRole: "owner" | "member" | null;
  launch: LaunchPreset | null;
  main: boolean;
  nodeKind: "app" | "schema-data";
  schemaKey: string | null;
};

function launchFromBlock(block: z.infer<typeof launchBlockSchema> | undefined, base: LaunchPreset | null): LaunchPreset | null {
  if (!block || !Object.keys(block).length) return base;
  const permission = block.permission ?? block.permissionMode;
  if (permission === "full") throw new Error("Manifest launch permission cannot be full");
  const providerId = block.providerId ?? block.provider;
  const model = block.model;
  const merged: LaunchPreset = {
    execution: providerId && model ? {
      providerId, model,
      reasoningLevel: block.reasoningLevel ?? block.reasoning ?? base?.execution?.reasoningLevel ?? "medium",
      ...(block.serviceTier ?? block["service-tier"] ? { serviceTier: block.serviceTier ?? block["service-tier"]! } : {}),
      permissionMode: permission ?? base?.execution?.permissionMode ?? "auto",
    } : base?.execution ? { ...base.execution } : null,
    workspace: block.workspace ?? base?.workspace ?? "checkout",
    initialPrompt: base?.initialPrompt ?? "",
  };
  return launchPresetSchema.parse(merged);
}

function readSoul(baseDir: string, soulPath: string) {
  const path = soulPath.startsWith("/") ? soulPath : resolve(baseDir, soulPath);
  const content = readFileSync(path, "utf8");
  if (content.length > 4096) throw new Error(`SOUL exceeds 4096 characters: ${soulPath}`);
  return content;
}

export function loadManifestFile(manifestPath: string) {
  const absolute = resolve(manifestPath);
  const baseDir = dirname(absolute);
  const raw = rawManifestSchema.parse(extname(absolute).toLowerCase() === ".json" ? JSON.parse(readFileSync(absolute, "utf8")) : parseYaml(readFileSync(absolute, "utf8")));
  const appName = raw.team ?? (typeof raw.app === "string" ? raw.app : undefined);
  if (!appName) throw new Error("Manifest must name the app with app: or team:");
  const projectSelector = raw.project ?? (typeof raw.app === "object" ? raw.app.bbProject : undefined) ?? appName;
  const defaultMachine = raw.defaults?.machine ?? (typeof raw.app === "object" ? raw.app.machine : undefined) ?? null;
  const defaultLaunch = launchFromBlock(raw.defaults?.launch ?? raw.defaults?.execution, null);
  const bots: NormalizedBotSpec[] = Object.entries(raw.bots).map(([key, spec]) => ({
    key, role: spec.role, soulPath: (spec.soulFile ?? spec.soul)!, parentKey: spec.parent ?? null,
    projectRole: spec.projectRole ?? null, launch: launchFromBlock(spec.launch ?? spec.execution, defaultLaunch),
    main: Boolean(spec.main), nodeKind: "app", schemaKey: null,
  }));
  const schemas = Object.entries(raw.schemas).map(([key, spec]) => {
    const folded = spec.foldedInto ?? (spec.data && "foldedInto" in spec.data ? spec.data.foldedInto : undefined);
    const data = spec.data && !folded && "role" in spec.data ? {
      key: "data", role: spec.data.role, soulPath: (spec.data.soulFile ?? spec.data.soul)!,
      parentKey: spec.data.parent ?? null, projectRole: spec.data.projectRole ?? "member",
      launch: launchFromBlock(spec.data.launch ?? spec.data.execution, defaultLaunch),
      main: Boolean(spec.data.main), nodeKind: "schema-data" as const, schemaKey: key,
    } : null;
    return { key, dataServicePath: spec.dataServicePath, database: spec.database, foldedInto: folded, data };
  });
  if (bots.filter((bot) => bot.projectRole === "owner").length !== 1) throw new Error("Manifest must declare exactly one owner bot");
  for (const bot of bots) {
    if (bot.parentKey && !raw.bots[bot.parentKey]) throw new Error(`Unknown parent bot key: ${bot.parentKey}`);
    readSoul(baseDir, bot.soulPath);
  }
  for (const schema of schemas) {
    if (schema.data) readSoul(baseDir, schema.data.soulPath);
    if (schema.foldedInto && !raw.bots[schema.foldedInto]) throw new Error(`foldedInto must name a bot key: ${schema.foldedInto}`);
  }
  return {
    version: raw.version ?? 1, appName, projectSelector, defaultMachine, defaultLaunch, bots, schemas,
    specialists: raw.specialists,
    charter: raw.charter ? { toKey: raw.charter.to, messagePath: resolve(baseDir, raw.charter.messageFile) } : null,
    baseDir,
  };
}

export function readManifestSoul(baseDir: string, soulPath: string) { return readSoul(baseDir, soulPath); }

export function topologicalBotOrder(bots: NormalizedBotSpec[]) {
  const byKey = new Map(bots.map((bot) => [bot.key, bot]));
  const ordered: NormalizedBotSpec[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();
  function visit(bot: NormalizedBotSpec) {
    if (done.has(bot.key)) return;
    if (visiting.has(bot.key)) throw new Error("Manifest bot parent cycle detected");
    visiting.add(bot.key);
    if (bot.parentKey) visit(byKey.get(bot.parentKey)!);
    visiting.delete(bot.key);
    done.add(bot.key);
    ordered.push(bot);
  }
  for (const bot of bots) visit(bot);
  return ordered;
}
