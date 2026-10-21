import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { createFakePluginHost, makeMessageDispatchHookContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { BotMetadata } from "../contract";
import { createBotStore } from "../lib/bot-store";
import { PLUGIN_MIGRATION_STATE_KEY } from "../lib/migrate-from-plugin";
import plugin from "../server";
import { avatar, backend, project } from "./backend-fixture";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function seedSidebarDatabase(path: string, botId = "bot_sidebar", linkedProjectIds: string[] = ["project"]) {
  mkdirSync(join(path, "state", botId), { recursive: true });
  writeFileSync(join(path, "state", botId, "SOUL.md"), "Sidebar soul");
  const db = new Database(join(path, "data.db"));
  db.exec(`
    CREATE TABLE bots (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE bot_threads (thread_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL);
    CREATE TABLE bot_state (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE bot_starts (token TEXT PRIMARY KEY, bot_id TEXT NOT NULL, created_at INTEGER NOT NULL, project_id TEXT);
    CREATE TABLE bot_project_owners (project_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, assigned_at INTEGER NOT NULL);
  `);
  db.prepare("INSERT INTO bots(id,data) VALUES (?,?)").run(botId, JSON.stringify({
    id: botId, name: "Sidebar bot", role: "Helper", avatar: { color: "#168b75", shape: "round", expression: "curious", motion: "still" },
    hostId: "host-home", stateReady: true, legacyHomeProjectId: null, linkedProjectIds, mainThreadId: "thread-1",
    hiddenUntilActivity: false, hiddenAt: null, sectionId: null, order: 0, soul: "Sidebar soul", agents: "", memory: "",
    settings: {}, stateHashes: { "SOUL.md": null, "AGENTS.md": null, "MEMORY.md": null, "settings.json": null }, updatedAt: 1, legacyProjectId: null,
  }));
  db.prepare("INSERT INTO bot_threads(thread_id,bot_id) VALUES (?,?)").run("thread-1", botId);
  db.close();
}

it("defers v1 project import until bots-sidebar storage is migrated", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "bots-migrate-"));
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const sidebarDir = join(dataDir, "plugins", "bots-sidebar");
  mkdirSync(sidebarDir, { recursive: true });
  seedSidebarDatabase(sidebarDir);
  const host = createFakePluginHost({
    pluginId: "bots-fleet",
    dataDir,
    sdk: {
      plugins: { list: async () => ({ plugins: [{ id: "bots-sidebar", enabled: false }] }) },
      projects: {
        list: async (args) => {
          const personal = { ...project("personal"), kind: "personal" as const, sources: [] };
          const work = project();
          return args?.includePersonal ? [work, personal] : [work];
        },
        get: async ({ projectId }) => {
          if (projectId === "personal") return { ...project("personal"), kind: "personal" as const, sources: [] };
          return project();
        },
        create: async () => { throw new Error("unexpected"); },
        update: async () => { throw new Error("unexpected"); },
      },
      hosts: { list: async () => [{ id: "host-project", name: "Execution machine", status: "connected" }] },
      files: {
        read: async ({ hostId, path }) => {
          if (path.endsWith("bot.json")) {
            return { content: JSON.stringify({ version: 1, role: "Chief of staff", avatar, mainThreadId: null, awaitingMain: false, sectionId: null, order: 0, updatedAt: 1 }), contentEncoding: "utf8", sha256: "x", sizeBytes: 1 };
          }
          throw new Error(`ENOENT: ${path}`);
        },
        write: async () => { throw new Error("unexpected"); },
        mkdir: async () => { throw new Error("unexpected"); },
      },
      threads: { list: async () => [], get: async () => { throw new Error("unexpected"); }, spawn: async () => { throw new Error("unexpected"); } },
    },
  });
  cleanups.push(() => host.harness.lifecycle.dispose());
  await plugin(host.bb);
  const before = await host.harness.behavior.callRpc("bots_list", null) as { bots: BotMetadata[]; warnings: string[] };
  expect(before.bots).toEqual([]);
  expect(before.warnings.join(" ")).toContain("migrate-from bots-sidebar");
  await expect(host.harness.behavior.callRpc("bot_create", {
    name: "Early bot", role: "Helper", hostId: "host-project", avatar, sectionId: null, linkedProjectIds: ["project"], soul: "Blocked",
  })).rejects.toThrow(/migrate-from bots-sidebar/);
  const migrate = await host.harness.behavior.runCli(["migrate-from", "bots-sidebar", "--json"]);
  expect(migrate.exitCode).toBe(0);
  const store = createBotStore(host.bb);
  expect(store.list()).toHaveLength(1);
  expect(store.owner("thread-1")).toBe("bot_sidebar");
  const after = await host.harness.behavior.callRpc("bots_list", null) as { bots: BotMetadata[] };
  expect(after.bots).toHaveLength(1);
  expect(after.bots[0]!.id).toBe("bot_sidebar");
});

it("imports bots-sidebar storage once and records migration metadata", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "bots-migrate-"));
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const sidebarDir = join(dataDir, "plugins", "bots-sidebar");
  mkdirSync(sidebarDir, { recursive: true });
  seedSidebarDatabase(sidebarDir);
  const host = createFakePluginHost({
    pluginId: "bots-fleet",
    dataDir,
    sdk: { plugins: { list: async () => ({ plugins: [{ id: "bots-sidebar", enabled: false }] }) } },
  });
  cleanups.push(() => host.harness.lifecycle.dispose());
  await plugin(host.bb);
  const result = await host.harness.behavior.runCli(["migrate-from", "bots-sidebar", "--json"]);
  const store = createBotStore(host.bb);
  if (result.exitCode !== 0) throw new Error(result.stderr ?? result.stdout ?? "migrate-from failed");
  const payload = JSON.parse(result.stdout!);
  expect(payload).toMatchObject({ sourcePluginId: "bots-sidebar", botCount: 1, bindingCount: 1 });
  expect(store.list()).toHaveLength(1);
  expect(store.owner("thread-1")).toBe("bot_sidebar");
  expect(store.state(PLUGIN_MIGRATION_STATE_KEY)).toMatchObject({ sourcePluginId: "bots-sidebar" });
  expect(readFileSync(join(dataDir, "plugins", "bots-fleet", "state", "bot_sidebar", "SOUL.md"), "utf8")).toBe("Sidebar soul");
  expect((await host.harness.behavior.runCli(["migrate-from", "bots-sidebar"])).exitCode).toBe(1);
});

it("refuses migration while bots-sidebar is enabled or pending starts remain", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "bots-migrate-"));
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const sidebarDir = join(dataDir, "plugins", "bots-sidebar");
  mkdirSync(sidebarDir, { recursive: true });
  seedSidebarDatabase(sidebarDir);
  const db = new Database(join(sidebarDir, "data.db"));
  db.prepare("INSERT INTO bot_starts(token,bot_id,created_at,project_id) VALUES (?,?,?,?)").run("token", "bot_sidebar", Date.now(), "project");
  db.close();
  const host = createFakePluginHost({
    pluginId: "bots-fleet",
    dataDir,
    sdk: { plugins: { list: async () => ({ plugins: [{ id: "bots-sidebar", enabled: true }] }) } },
  });
  cleanups.push(() => host.harness.lifecycle.dispose());
  await plugin(host.bb);
  expect((await host.harness.behavior.runCli(["migrate-from", "bots-sidebar"])).stderr).toContain("Disable bots-sidebar");
  const host2 = createFakePluginHost({
    pluginId: "bots-fleet",
    dataDir,
    sdk: { plugins: { list: async () => ({ plugins: [{ id: "bots-sidebar", enabled: false }] }) } },
  });
  cleanups.push(() => host2.harness.lifecycle.dispose());
  await plugin(host2.bb);
  expect((await host2.harness.behavior.runCli(["migrate-from", "bots-sidebar"])).stderr).toContain("pending conversation starts");
});

it("finishes pending starts and routes threads created under bots-sidebar origin", async () => {
  const host = await backend();
  cleanups.push(() => host.harness.lifecycle.dispose());
  const owner = await host.create("Owner");
  const member = await host.create("Sidebar bot");
  await host.harness.behavior.callRpc("state_apply", { botId: owner.id, change: { target: "project", action: "own", projectId: "project" } });
  const token = "22222222-2222-4222-8222-222222222222";
  host.store.stageStart(token, member.id, "project");
  const pending = makeThreadResponse({ id: "sidebar-pending", projectId: "project", originPluginId: "bots-sidebar", status: "pending", createdAt: Date.now() + 1 });
  host.threads.set(pending.id, pending);
  await host.harness.inspection.registrations.hooks["message.dispatch"]!(makeMessageDispatchHookContext({
    thread: pending,
    input: { blocks: [{ type: "text", text: `[bb-bot-start:${token}]`, visibility: "agent-only", mentions: [] }] },
  }));
  expect(host.store.owner(pending.id)).toBe(member.id);
  expect(host.store.pendingStart(token)).toBeNull();
});
