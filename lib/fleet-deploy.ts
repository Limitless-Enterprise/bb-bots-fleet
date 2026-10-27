import { createHash } from "node:crypto";
import type { BbPluginApi, PluginCliContext } from "@get-bb/plugin-sdk";
import type { BotMetadata } from "../contract";
import { avatarSchema } from "../contract";
import type { BotStore } from "./bot-store";
import type { FleetOps } from "./fleet-cli";
import { runTree } from "./fleet-cli";
import { assertFleetRegistryOperator } from "./fleet-authz";
import { assertFleetProjectAllowed } from "./fleet-project-guard";
import { assertAppNodeNameAvailable, newNodeId, validateFoldedIntoAddress, validateSchemaNodeMetadata, type BotNode, type BotNodeMetadata } from "./bot-nodes";
import { botAddress, resolveBotSelector, resolveMachine, resolveProject } from "./fleet-resolve";
import { loadManifestFile, readManifestSoul, topologicalBotOrder, type NormalizedBotSpec } from "./manifest";
import { runMainCommand } from "./fleet-main";
import {
  ensureNamedSection,
  FLEET_SECTION_NAME,
  sectionAssignmentPlan,
  sectionNameForBot,
  SHARED_SECTION_NAME,
} from "./fleet-sections";

const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");
const avatar = () => avatarSchema.parse({ color: "#168b75", shape: "round", expression: "curious", motion: "still" });

function validateDeployFoldedInto(
  manifest: ReturnType<typeof loadManifestFile>,
  dryRun: boolean,
  nodes: ReturnType<BotStore["nodes"]["list"]>,
  bots: BotMetadata[],
  app: BotNode,
  foldedInto: string,
) {
  try {
    validateFoldedIntoAddress(nodes, bots, app, foldedInto);
  } catch (error) {
    if (!dryRun) throw error;
    const suffix = foldedInto.slice(manifest.appName.length + 1);
    if (
      foldedInto.startsWith(`${manifest.appName}/`) &&
      (suffix === "api" || suffix === "builder") &&
      manifest.bots.some((bot) => bot.key === suffix)
    ) {
      return;
    }
    throw error;
  }
}

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

  let appNode = store.nodes.list().find((node) => node.kind === "app" && node.name === manifest.appName && !node.parentNodeId) ?? null;

  const sectionReports: Array<{ name: string; status: string }> = [];
  for (const name of [FLEET_SECTION_NAME, SHARED_SECTION_NAME, manifest.appName]) {
    const { created } = await ensureNamedSection(store, ops, name, dryRun);
    sectionReports.push({ name, status: created ? (dryRun ? "skipped" : "created") : "unchanged" });
  }
  const appSection = await ensureNamedSection(store, ops, manifest.appName, dryRun);
  const sectionId = appSection.id;
  for (const line of sectionReports) report.push({ action: "section", target: line.name, status: line.status });

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

  const releaseManifestOwnerUnless = async (botId: string | null) => {
    if (dryRun) return;
    const current = store.projectOwner(project.id);
    if (current && current.botId !== botId) await ops.updateProjectRole(current.botId, "release", project.id);
  };
  const reconcileManifestOwner = async (botId: string) => {
    if (dryRun) return;
    await releaseManifestOwnerUnless(botId);
    if (store.projectOwner(project.id)?.botId !== botId) await ops.updateProjectRole(botId, "own", project.id);
  };

  const upsert = async (spec: NormalizedBotSpec, nodeId: string) => {
    const soul = readManifestSoul(manifest.baseDir, spec.soulPath);
    const parentId = spec.parentKey ? store.list().find((bot) => bot.nodeId === appNode!.id && bot.name === spec.parentKey)?.id ?? null : null;
    const existing = store.list().find((bot) => bot.nodeId === nodeId && bot.name === spec.key);
    const address = existing ? botAddress(store.nodes.list(), existing) : `${manifest.appName}/${spec.key}`;
    if (!existing) {
      if (!dryRun) {
        if (spec.projectRole === "owner") await releaseManifestOwnerUnless(null);
        await ops.createBot({ name: spec.key, role: spec.role, hostId: machine.id, avatar: avatar(), sectionId, linkedProjectIds: [project.id], ownedProjectIds: spec.projectRole === "owner" ? [project.id] : undefined, soul, nodeId, parentBotId: parentId, ...(spec.launch ? { launchPreset: spec.launch } : {}) });
        if (spec.projectRole === "owner") {
          const created = store.list().find((bot) => bot.nodeId === nodeId && bot.name === spec.key);
          if (created) await reconcileManifestOwner(created.id);
        }
      }
      report.push({ action: "bot", target: address, status: dryRun ? "skipped" : "created" });
      return;
    }
    const patch: Partial<{ role: string; soul: string; hostId: string; launchPreset: BotMetadata["launchPreset"]; parentBotId: string | null; sectionId: string | null }> = {};
    if (existing.role !== spec.role) patch.role = spec.role;
    if (existing.hostId !== machine.id) patch.hostId = machine.id;
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
    const targetSectionName = sectionNameForBot(spec.key, manifest.appName);
    if (targetSectionName) {
      const plan = sectionAssignmentPlan(existing, targetSectionName, store);
      if (plan === "assign") {
        const target = store.sections().find((section) => section.name === targetSectionName);
        if (target) patch.sectionId = target.id;
      } else if (plan === "blocked" && dryRun) {
        report.push({ action: "section", target: address, status: `would-move-to-${targetSectionName}-blocked` });
      }
    }
    if (Object.keys(patch).length && !dryRun) await ops.updateBot(existing.id, patch);
    report.push({ action: "bot", target: address, status: Object.keys(patch).length || joinedProject ? dryRun ? "skipped" : "updated" : "unchanged" });
    if (spec.projectRole === "owner" && !dryRun) await reconcileManifestOwner(existing.id);
  };

  const mainSpecs = [...manifest.bots, ...manifest.schemas.map((s) => s.data).filter(Boolean) as NormalizedBotSpec[]].filter((s) => s.main);
  const resolveMainBot = (spec: NormalizedBotSpec) => {
    if (spec.schemaKey) {
      const schemaNode = store.nodes.list().find((node) => node.parentNodeId === appNode!.id && node.name === spec.schemaKey);
      if (!schemaNode) return undefined;
      return store.list().find((entry) => entry.nodeId === schemaNode.id && entry.name === "data");
    }
    return store.list().find((entry) => entry.nodeId === appNode!.id && entry.name === spec.key);
  };
  const mainTargetAddress = (spec: NormalizedBotSpec) =>
    spec.schemaKey ? `${manifest.appName}/${spec.schemaKey}/data` : `${manifest.appName}/${spec.key}`;
  const willOpenMain = async (spec: NormalizedBotSpec) => {
    const bot = resolveMainBot(spec);
    if (!bot) return true;
    if (!bot.mainThreadId) return true;
    try {
      const existing = await bb.sdk.threads.get({ threadId: bot.mainThreadId });
      return Boolean(existing.archivedAt);
    } catch {
      return true;
    }
  };
  for (const spec of topologicalBotOrder(manifest.bots)) await upsert(spec, appNode!.id);

  let exitCode = 0;
  const schemaUpserts: Array<{ spec: NormalizedBotSpec; nodeId: string }> = [];
  for (const schema of manifest.schemas) {
    const metadata: BotNodeMetadata = { ...(schema.dataServicePath ? { dataServicePath: schema.dataServicePath } : {}), ...(schema.database ? { database: schema.database } : {}), ...(schema.foldedInto ? { foldedInto: schema.foldedInto } : {}) };
    try {
      validateSchemaNodeMetadata(store.nodes.list(), appNode!, metadata);
    } catch (error) {
      exitCode = 1;
      report.push({
        action: "schema",
        target: `${manifest.appName}/${schema.key}`,
        status: error instanceof Error ? `failed: ${error.message}` : "failed",
      });
      continue;
    }
    if (schema.foldedInto) {
      try {
        validateDeployFoldedInto(manifest, dryRun, store.nodes.list(), store.list(), appNode!, schema.foldedInto);
      } catch (error) {
        exitCode = 1;
        report.push({
          action: "folded-into",
          target: `${manifest.appName}/${schema.key}`,
          status: error instanceof Error ? `failed: ${error.message}` : "failed",
        });
        continue;
      }
    }
    let schemaNode = store.nodes.list().find((node) => node.parentNodeId === appNode!.id && node.name === schema.key);
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
      if (schema.foldedInto && !dryRun) {
        const orphan = store.list().find((bot) => bot.nodeId === schemaNode!.id && bot.name === "data");
        if (orphan) {
          store.removeRegistryBot(orphan.id);
          report.push({ action: "bot", target: `${manifest.appName}/${schema.key}/data`, status: "removed" });
        }
      }
    }
    if (schema.data && schemaNode) schemaUpserts.push({ spec: schema.data, nodeId: schemaNode.id });
  }
  for (const { spec, nodeId } of schemaUpserts) await upsert(spec, nodeId);
  for (const specialist of manifest.specialists) {
    const bot = resolveBotSelector(store, specialist);
    if (!bot.linkedProjectIds.includes(project.id) && !dryRun) await ops.updateProjectRole(bot.id, "join", project.id);
    const targetSectionName = sectionNameForBot(bot.name, manifest.appName);
    if (targetSectionName) {
      const plan = sectionAssignmentPlan(bot, targetSectionName, store);
      if (plan === "assign" && !dryRun) {
        const target = store.sections().find((section) => section.name === targetSectionName);
        if (target) await ops.updateBot(bot.id, { sectionId: target.id });
        report.push({ action: "section", target: bot.name, status: "assigned" });
      } else if (plan === "blocked" && dryRun) {
        report.push({ action: "section", target: bot.name, status: `would-move-to-${targetSectionName}-blocked` });
      }
    }
  }
  if (!dryRun) {
    for (const spec of mainSpecs) {
      const bot = resolveMainBot(spec);
      const address = bot ? botAddress(store.nodes.list(), bot) : mainTargetAddress(spec);
      if (!bot) {
        exitCode = 1;
        report.push({ action: "main", target: address, status: "failed: main bot not found" });
        continue;
      }
      const openMain = await willOpenMain(spec);
      if (openMain) {
        try {
          await runMainCommand([address, "--project", project.id], ctx, bb, store, ops, personalProjectId, caller);
          report.push({ action: "main", target: address, status: "opened" });
        } catch (error) {
          exitCode = 1;
          report.push({ action: "main", target: address, status: error instanceof Error ? `failed: ${error.message}` : "failed" });
        }
      } else {
        report.push({ action: "main", target: address, status: "unchanged" });
      }
    }
  }
  const previewTree = dryRun ? dryRunManifestTree(manifest, project.id, store) : null;
  const treeStdout = previewTree
    ? (flags.json ? JSON.stringify(previewTree) : previewTree.apps.flatMap((block) => block.lines).join("\n"))
    : (await runTree([manifest.appName, ...(flags.json ? ["--json"] : [])], ctx, store)).stdout ?? "";
  return { exitCode, stdout: flags.json ? JSON.stringify({ dryRun, report, tree: treeStdout ? JSON.parse(treeStdout) : undefined }) : [...report.map((line) => `${line.status}\t${line.action}\t${line.target}`), "", treeStdout].join("\n") };
}
