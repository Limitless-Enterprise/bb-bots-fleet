import { createHash } from "node:crypto";
import type { BbPluginApi, PluginCliContext } from "@get-bb/plugin-sdk";
import type { BotMetadata } from "../contract";
import { avatarSchema } from "../contract";
import type { BotStore } from "./bot-store";
import type { FleetOps } from "./fleet-cli";
import { runTree } from "./fleet-cli";
import { assertFleetRegistryOperator } from "./fleet-authz";
import { assertFleetProjectAllowed } from "./fleet-project-guard";
import { assertAppNodeNameAvailable, newNodeId, resolveNodePath, validateFoldedIntoAddress, validateSchemaNodeMetadata, type BotNodeMetadata } from "./bot-nodes";
import { botAddress, resolveBotSelector, resolveMachine, resolveProject } from "./fleet-resolve";
import { loadManifestFile, readManifestSoul, topologicalBotOrder, type NormalizedBotSpec } from "./manifest";
import { runMainCommand } from "./fleet-main";

const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");
const avatar = () => avatarSchema.parse({ color: "#168b75", shape: "round", expression: "curious", motion: "still" });

function dryRunManifestTree(manifest: ReturnType<typeof loadManifestFile>, projectId: string, store: BotStore) {
  const lines = [`${manifest.appName} (project ${projectId})`];
  for (const root of topologicalBotOrder(manifest.bots).filter((bot) => !bot.parentKey)) {
    lines.push(`  ${manifest.appName}/${root.key}`);
  }
  for (const member of topologicalBotOrder(manifest.bots).filter((bot) => bot.parentKey)) {
    lines.push(`    ${manifest.appName}/${member.key} (parent ${manifest.appName}/${member.parentKey})`);
  }
  for (const schema of manifest.schemas) {
    const path = `${manifest.appName}/${schema.key}`;
    if (schema.foldedInto) lines.push(`    ${path} (folded into ${schema.foldedInto})`);
    else if (schema.data) lines.push(`    ${path}/data`);
    else lines.push(`    ${path}/data (missing)`);
  }
  const shared = store.list().filter((bot) => !(bot.nodeId ?? null));
  for (const bot of shared) {
    if (bot.linkedProjectIds.includes(projectId)) lines.push(`  ${bot.name} (engaged)`);
  }
  return {
    apps: [{ app: manifest.appName, lines }],
    shared: shared.map((bot) => ({ id: bot.id, name: bot.name, address: bot.name })),
  };
}

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
  if (!appNode) {
    assertAppNodeNameAvailable(store.nodes.list(), store.list(), manifest.appName);
    appNode = { id: newNodeId(), kind: "app", name: manifest.appName, parentNodeId: null, projectId: project.id, sectionId: null, metadata: {}, createdAt: Date.now() };
    if (dryRun) report.push({ action: "node", target: manifest.appName, status: "skipped" });
    else {
      store.nodes.save(appNode);
      report.push({ action: "node", target: manifest.appName, status: "created" });
    }
  } else if (appNode.projectId !== project.id) {
    appNode = { ...appNode, projectId: project.id };
    if (!dryRun) store.nodes.save(appNode);
    report.push({ action: "node", target: manifest.appName, status: dryRun ? "skipped" : "updated" });
  }

  const upsert = async (spec: NormalizedBotSpec, nodeId: string) => {
    const soul = readManifestSoul(manifest.baseDir, spec.soulPath);
    const parentId = spec.parentKey ? store.list().find((bot) => bot.nodeId === appNode!.id && bot.name === spec.parentKey)?.id ?? null : null;
    const existing = store.list().find((bot) => bot.nodeId === nodeId && bot.name === spec.key);
    const address = existing ? botAddress(store.nodes.list(), existing) : `${manifest.appName}/${spec.key}`;
    if (!existing) {
      if (!dryRun) {
        await ops.createBot({ name: spec.key, role: spec.role, hostId: machine.id, avatar: avatar(), sectionId, linkedProjectIds: [project.id], ownedProjectIds: spec.projectRole === "owner" ? [project.id] : undefined, soul, nodeId, parentBotId: parentId, ...(spec.launch ? { launchPreset: spec.launch } : {}) });
      }
      report.push({ action: "bot", target: address, status: dryRun ? "skipped" : "created" });
      return;
    }
    const patch: Partial<{ role: string; soul: string; launchPreset: BotMetadata["launchPreset"]; parentBotId: string | null }> = {};
    if (existing.role !== spec.role) patch.role = spec.role;
    if (sha256(soul) !== sha256(existing.soul)) patch.soul = soul;
    if (spec.launch) {
      if (JSON.stringify(existing.launchPreset) !== JSON.stringify(spec.launch)) patch.launchPreset = spec.launch;
    } else if (existing.launchPreset != null) patch.launchPreset = null;
    if ((existing.parentBotId ?? null) !== parentId) patch.parentBotId = parentId;
    let joinedProject = false;
    if (spec.projectRole === "member" && !existing.linkedProjectIds.includes(project.id) && !dryRun) {
      await ops.updateProjectRole(existing.id, "join", project.id);
      joinedProject = true;
    }
    if (Object.keys(patch).length && !dryRun) await ops.updateBot(existing.id, patch);
    report.push({ action: "bot", target: address, status: Object.keys(patch).length || joinedProject ? dryRun ? "skipped" : "updated" : "unchanged" });
    if (spec.projectRole === "owner" && !store.projectOwner(project.id) && !dryRun) await ops.updateProjectRole(existing.id, "own", project.id);
  };

  const schemaUpserts: Array<{ spec: NormalizedBotSpec; nodeId: string }> = [];
  for (const schema of manifest.schemas) {
    const metadata: BotNodeMetadata = { ...(schema.dataServicePath ? { dataServicePath: schema.dataServicePath } : {}), ...(schema.database ? { database: schema.database } : {}), ...(schema.foldedInto ? { foldedInto: schema.foldedInto } : {}) };
    let schemaNode = store.nodes.list().find((node) => node.parentNodeId === appNode!.id && node.name === schema.key);
    validateSchemaNodeMetadata(store.nodes.list(), appNode!, metadata);
    if (metadata.foldedInto) validateFoldedIntoAddress(store.nodes.list(), store.list(), appNode!, metadata.foldedInto);
    if (!schemaNode) {
      schemaNode = { id: newNodeId(), kind: "schema", name: schema.key, parentNodeId: appNode!.id, projectId: null, sectionId: null, metadata, createdAt: Date.now() };
      if (!dryRun) store.nodes.save(schemaNode);
    } else {
      const nextMetadata: BotNodeMetadata = {
        ...(schemaNode.metadata.registryRef ? { registryRef: schemaNode.metadata.registryRef } : {}),
        ...(schema.dataServicePath ? { dataServicePath: schema.dataServicePath } : {}),
        ...(schema.database ? { database: schema.database } : {}),
        ...(schema.foldedInto ? { foldedInto: schema.foldedInto } : {}),
      };
      if (JSON.stringify(schemaNode.metadata) !== JSON.stringify(nextMetadata)) {
        schemaNode = { ...schemaNode, metadata: nextMetadata };
        if (!dryRun) store.nodes.save(schemaNode);
      }
    }
    if (schema.data && schemaNode) schemaUpserts.push({ spec: schema.data, nodeId: schemaNode.id });
  }
  for (const spec of topologicalBotOrder(manifest.bots)) await upsert(spec, appNode!.id);
  for (const { spec, nodeId } of schemaUpserts) await upsert(spec, nodeId);
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
          try {
            const existing = await bb.sdk.threads.get({ threadId: bot.mainThreadId });
            openMain = Boolean(existing.archivedAt);
          } catch {
            openMain = true;
          }
        }
        if (openMain) {
          await runMainCommand([botAddress(store.nodes.list(), bot), "--project", project.id], ctx, bb, store, ops, personalProjectId, caller);
        }
      }
    }
  }
  const previewTree = dryRun ? dryRunManifestTree(manifest, project.id, store) : null;
  const treeStdout = previewTree
    ? (flags.json ? JSON.stringify(previewTree) : previewTree.apps.flatMap((block) => block.lines).join("\n"))
    : (await runTree([manifest.appName, ...(flags.json ? ["--json"] : [])], ctx, store)).stdout ?? "";
  return { exitCode: 0, stdout: flags.json ? JSON.stringify({ dryRun, report, tree: treeStdout ? JSON.parse(treeStdout) : undefined }) : [...report.map((line) => `${line.status}\t${line.action}\t${line.target}`), "", treeStdout].join("\n") };
}
