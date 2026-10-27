import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createBotStore } from "../lib/bot-store";
import { sidebarMigrationPending, sidebarSourceHasBotData } from "../lib/migrate-bots";
import plugin from "../server";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.restoreAllMocks(); });

it("treats unreadable sidebar storage as migration pending instead of allowing creates", async () => {
  const sourceDir = mkdtempSync(join(tmpdir(), "sidebar-probe-"));
  cleanups.push(() => rmSync(sourceDir, { recursive: true, force: true }));
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, "data.db"), "not a sqlite database");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(sidebarSourceHasBotData(sourceDir)).toBe(true);
  expect(warn).toHaveBeenCalled();

  const dataDir = mkdtempSync(join(tmpdir(), "bots-fleet-probe-"));
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  mkdirSync(join(dataDir, "plugins", "bots-sidebar"), { recursive: true });
  writeFileSync(join(dataDir, "plugins", "bots-sidebar", "data.db"), "not a sqlite database");

  const host = createFakePluginHost({
    pluginId: "bots-fleet",
    dataDir,
    sdk: {
      plugins: { list: async () => ({ plugins: [{ id: "bots-sidebar", enabled: false }] }) },
      projects: { list: async () => [], get: async () => { throw new Error("unexpected"); }, create: async () => { throw new Error("unexpected"); }, update: async () => { throw new Error("unexpected"); } },
      hosts: { list: async () => [{ id: "host-project", name: "Execution machine", status: "connected" }] },
      files: { read: async () => { throw new Error("ENOENT"); }, write: async () => { throw new Error("unexpected"); }, mkdir: async () => { throw new Error("unexpected"); } },
      threads: { list: async () => [], get: async () => { throw new Error("unexpected"); }, spawn: async () => { throw new Error("unexpected"); } },
    },
  });
  cleanups.push(() => host.harness.lifecycle.dispose());
  await plugin(host.bb);
  const store = createBotStore(host.bb);
  expect(sidebarMigrationPending(host.bb, store)).toBe(true);
  expect(existsSync(join(dataDir, "plugins", "bots-sidebar", "data.db"))).toBe(true);
});

it("returns false when sidebar database exists but has no bot rows", () => {
  const sourceDir = mkdtempSync(join(tmpdir(), "sidebar-empty-"));
  cleanups.push(() => rmSync(sourceDir, { recursive: true, force: true }));
  const db = new Database(join(sourceDir, "data.db"));
  db.exec("CREATE TABLE bots (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE bot_threads (thread_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL);");
  db.close();
  expect(sidebarSourceHasBotData(sourceDir)).toBe(false);
});
