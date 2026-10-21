import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { createFakePluginHost, makeMessageDispatchHookContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createBotStore } from "../lib/bot-store";
import { PLUGIN_MIGRATION_STATE_KEY } from "../lib/migrate-from-plugin";
import plugin from "../server";
import { backend } from "./backend-fixture";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function seedSidebarDatabase(path: string, botId = "bot_sidebar") {
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
    hostId: "host-home", stateReady: true, legacyHomeProjectId: null, linkedProjectIds: [], mainThreadId: "thread-1",
    hiddenUntilActivity: false, hiddenAt: null, sectionId: null, order: 0, soul: "Sidebar soul", agents: "", memory: "",
    settings: {}, stateHashes: { "SOUL.md": null, "AGENTS.md": null, "MEMORY.md": null, "settings.json": null }, updatedAt: 1, legacyProjectId: null,
  }));
  db.prepare("INSERT INTO bot_threads(thread_id,bot_id) VALUES (?,?)").run("thread-1", botId);
  db.close();
}

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
