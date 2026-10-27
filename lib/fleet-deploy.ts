import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { BbPluginApi, PluginCliContext } from "@get-bb/plugin-sdk";
import type { BotMetadata } from "../contract";
import { avatarSchema } from "../contract";
import type { BotStore } from "./bot-store";
import type { FleetOps } from "./fleet-cli";
import { runTree } from "./fleet-cli";
import { assertFleetRegistryOperator } from "./fleet-authz";
import { assertFleetProjectAllowed } from "./fleet-project-guard";
import { newNodeId, resolveNodePath, validateFoldedIntoAddress, validateSchemaNodeMetadata, type BotNodeMetadata } from "./bot-nodes";
import { botAddress, resolveBotSelector, resolveMachine, resolveProject } from "./fleet-resolve";
import { loadManifestFile, readManifestSoul, topologicalBotOrder, type NormalizedBotSpec } from "./manifest";
import { runMainCommand } from "./fleet-main";

const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");
const avatar = () => avatarSchema.parse({ color: "#168b75", shape: "round", expression: "curious", motion: "still" });

export async function runDeployCommand(argv: string[], ctx: PluginCliContext, bb: BbPluginApi, store: BotStore, ops: FleetOps, personalProjectId: () => Promise<string>, caller: BotMetadata | null) {
  assertFleetRegistryOperator(ctx, caller);
  const flags = { json: argv.includes("--json"), apply: argv.includes("--apply") };
  const manifestPath = argv.find((arg) => !arg.startsWith("--"));
  if (!manifestPath) throw new Error("Usage: bb bots deploy <manifest> [--apply] [--json]");
  const dryRun = !flags.apply;
  const manifest = loadManifestFile(manifestPath);
  const project = await resolveProject(bb, manifest.projectSelector);
  assertFleetProjectAllowed(project, "own");
  if (!manifest.defaultMachine) throw new Error("Manifest must set defaults.machine or app.machine");
  const machine = await resolveMachine(bb, manifest.defaultMachine);
  const report: Array<{ action: string; target: string; status: string }> = [];
  for (const specialist of manifest.specialists) resolveBotSelector(store, specialist);

  let sectionId = store.sections().find((section) => section.name === manifest.appName)?.id ?? null;
  if (!sectionId && !dryRun) sectionId = (await ops.createSection(manifest.appName)).id;
  report.push({ action: "section", target: manifest.appName, status: sectionId ? "unchanged" : dryRun ? "skipped" : "created" });

  let appNode = store.nodes.list().find((node) => node.kind === "app" && node.name === manifest.appName && !node.parentNodeId) ?? null;
  const deployNewApp = !appNode;
  if (!appNode) {
    appNode = { id: newNodeId(), kind: "app", name: manifest.appName, parentNodeId: null, projectId: project.id, sectionId: null, metadata: {}, createdAt: Date.now() };
    if (dryRun) report.push({ action: "node", target: manifest.appName, status: "skipped" });
    else {
      store.nodes.save(appNode);
      report.push({ action: "node", target: manifest.appName, status: "created" });
    }
  }

  const upsert = async (spec: NormalizedBotSpec, nodeId: string) => {
    const soul = readManifestSoul(manifest.baseDir, spec.soulPath);
    const parentId = spec.parentKey ? store.list().find((bot) => bot.nodeId === appNode!.id && bot.name === spec.parentKey)?.id ?? null : null;
    const existing = store.list().find((bot) => bot.nodeId === nodeId && bot.name === spec.key);
    const address = existing ? botAddress(store.nodes.list(), existing) : `${manifest.appName}/${spec.key}`;
    if (!existing) {
      if (!dryRun) await ops.createBot({ name: spec.key, role: spec.role, hostId: machine.id, avatar: avatar(), sectionId, linkedProjectIds: [project.id], ownedProjectIds: spec.projectRole === "owner" ? [project.id] : undefined, soul, nodeId, parentBotId: parentId, ...(spec.launch ? { launchPreset: spec.launch } : {}) });
      report.push({ action: "bot", target: address, status: dryRun ? "skipped" : "created" });
      return;
    }
    const patch: Partial<{ role: string; soul: string; launchPreset: BotMetadata["launchPreset"] }> = {};
    if (existing.role !== spec.role) patch.role = spec.role;
    if (sha256(soul) !== sha256(existing.soul)) patch.soul = soul;
    if (spec.launch && JSON.stringify(existing.launchPreset) !== JSON.stringify(spec.launch)) patch.launchPreset = spec.launch;
    if (Object.keys(patch).length && !dryRun) await ops.updateBot(existing.id, patch);
    report.push({ action: "bot", target: address, status: Object.keys(patch).length ? dryRun ? "skipped" : "updated" : "unchanged" });
    if (spec.projectRole === "owner" && !store.projectOwner(project.id) && !dryRun) await ops.updateProjectRole(existing.id, "own", project.id);
  };

  for (const schema of manifest.schemas) {
    const metadata: BotNodeMetadata = { ...(schema.dataServicePath ? { dataServicePath: schema.dataServicePath } : {}), ...(schema.database ? { database: schema.database } : {}), ...(schema.foldedInto ? { foldedInto: schema.foldedInto } : {}) };
    let schemaNode = store.nodes.list().find((node) => node.parentNodeId === appNode!.id && node.name === schema.key);
    if (!schemaNode) {
      if (dryRun) {
        schemaNode = { id: newNodeId(), kind: "schema", name: schema.key, parentNodeId: appNode!.id, projectId: null, sectionId: null, metadata, createdAt: Date.now() };
      } else {
        validateSchemaNodeMetadata(store.nodes.list(), appNode!, metadata);
        if (metadata.foldedInto) validateFoldedIntoAddress(store.nodes.list(), store.list(), appNode!, metadata.foldedInto);
        schemaNode = { id: newNodeId(), kind: "schema", name: schema.key, parentNodeId: appNode!.id, projectId: null, sectionId: null, metadata, createdAt: Date.now() };
        store.nodes.save(schemaNode);
      }
    }
    if (schema.data && schemaNode) await upsert(schema.data, schemaNode.id);
  }
  for (const spec of topologicalBotOrder(manifest.bots)) await upsert(spec, appNode!.id);
  for (const specialist of manifest.specialists) {
    const bot = resolveBotSelector(store, specialist);
    if (!bot.linkedProjectIds.includes(project.id) && !dryRun) await ops.updateProjectRole(bot.id, "join", project.id);
  }
  if (!dryRun) {
    for (const spec of [...manifest.bots, ...manifest.schemas.map((s) => s.data).filter(Boolean) as NormalizedBotSpec[]].filter((s) => s.main)) {
      const bot = spec.schemaKey
        ? store.list().find((entry) => entry.nodeId === resolveNodePath(store.nodes.list(), `${manifest.appName}/${spec.schemaKey}`).id && entry.name === "data")
        : store.list().find((entry) => entry.nodeId === appNode!.id && entry.name === spec.key);
      if (bot) {
        let openMain = !bot.mainThreadId;
        if (!openMain && bot.mainThreadId) {
          const existing = await bb.sdk.threads.get({ threadId: bot.mainThreadId });
          openMain = Boolean(existing.archivedAt);
        }
        if (openMain) await runMainCommand([botAddress(store.nodes.list(), bot), "--project", project.id], ctx, bb, store, ops, personalProjectId, caller);
      }
    }
    if (manifest.charter) {
      const lead = store.list().find((entry) => entry.nodeId === appNode!.id && entry.name === manifest.charter!.toKey);
      if (lead?.mainThreadId) await bb.sdk.threads.send({ threadId: lead.mainThreadId, mode: "queue-if-active", input: [{ type: "text", text: readFileSync(manifest.charter.messagePath, "utf8"), mentions: [] }] });
    }
  }
  const treeStdout = dryRun && deployNewApp
    ? (flags.json ? JSON.stringify({ apps: [], shared: [] }) : "")
    : (await runTree([manifest.appName, ...(flags.json ? ["--json"] : [])], ctx, store)).stdout ?? "";
  return { exitCode: 0, stdout: flags.json ? JSON.stringify({ dryRun, report, tree: treeStdout ? JSON.parse(treeStdout) : undefined }) : [...report.map((line) => `${line.status}\t${line.action}\t${line.target}`), "", treeStdout].join("\n") };
}
