import Database from "better-sqlite3";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { BotStore } from "./bot-store";
import { pluginDataDirectory } from "./plugin-data-dir";

export const PLUGIN_MIGRATION_STATE_KEY = "plugin-migration-from";
const SUPPORTED_SOURCES = new Set(["bots-sidebar"]);
const DATA_TABLES = ["bots", "bot_threads", "bot_state", "bot_starts", "bot_project_owners"] as const;

export type MigrateFromResult = {
  sourcePluginId: string;
  botCount: number;
  bindingCount: number;
  copiedStateBots: number;
};

function copyTable(legacy: Database.Database, target: Database.Database, table: string) {
  target.exec(`DELETE FROM ${table}`);
  const rows = legacy.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
  if (!rows.length) return;
  const columns = Object.keys(rows[0]!);
  const insert = target.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
  for (const row of rows) insert.run(...columns.map((column) => row[column]));
}

export function stateCopyFailureMessage(stateStaging: string, cause: unknown) {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return `Failed to copy bot state from staged path ${stateStaging}: ${detail}`;
}

function snapshotSourceDatabase(sourceDbPath: string, scratchDb: string) {
  copyFileSync(sourceDbPath, scratchDb);
  for (const suffix of ["-wal", "-shm"] as const) {
    const sidecar = `${sourceDbPath}${suffix}`;
    if (existsSync(sidecar)) copyFileSync(sidecar, `${scratchDb}${suffix}`);
  }
}

export async function migrateFromPlugin(bb: BbPluginApi, store: BotStore, sourcePluginId: string): Promise<MigrateFromResult> {
  if (!SUPPORTED_SOURCES.has(sourcePluginId)) throw new Error(`Unsupported source plugin: ${sourcePluginId}`);
  if (store.state<{ sourcePluginId: string }>(PLUGIN_MIGRATION_STATE_KEY)) {
    throw new Error("Bots Fleet storage was already migrated; this command is one-time only");
  }
  if (store.list().length || store.bindings().length) {
    throw new Error("Bots Fleet already has bot data. Migrate only into a fresh install before creating bots here.");
  }
  const plugins = await bb.sdk.plugins.list();
  const source = plugins.plugins.find((entry) => entry.id === sourcePluginId);
  if (source?.enabled) {
    throw new Error(`Disable ${sourcePluginId} before migrating (${sourcePluginId} must be stopped so its database is not open)`);
  }
  const sourceDir = pluginDataDirectory(bb, sourcePluginId);
  const targetDir = pluginDataDirectory(bb, bb.pluginId);
  const sourceDbPath = join(sourceDir, "data.db");
  if (!existsSync(sourceDbPath)) throw new Error(`No plugin data found for ${sourcePluginId} at ${sourceDir}`);
  const scratchDir = mkdtempSync(join(tmpdir(), "bots-fleet-migrate-"));
  const scratchDb = join(scratchDir, "source.db");
  let legacy: Database.Database | null = null;
  let preserveScratch = false;
  try {
    snapshotSourceDatabase(sourceDbPath, scratchDb);
    legacy = new Database(scratchDb, { readonly: true });
    const pending = (legacy.prepare("SELECT COUNT(*) AS count FROM bot_starts").get() as { count: number }).count;
    if (pending > 0) throw new Error("Resolve pending conversation starts in bots-sidebar before migrating");
    const sourceState = join(sourceDir, "state");
    const stateStaging = join(scratchDir, "state-staging");
    if (existsSync(sourceState)) cpSync(sourceState, stateStaging, { recursive: true });
    const migrationMeta = { sourcePluginId, migratedAt: Date.now(), sourceDatabase: sourceDbPath };
    const target = bb.storage.database();
    const summary = target.transaction(() => {
      for (const table of DATA_TABLES) copyTable(legacy!, target, table);
      const botCount = (target.prepare("SELECT COUNT(*) AS count FROM bots").get() as { count: number }).count;
      const bindingCount = (target.prepare("SELECT COUNT(*) AS count FROM bot_threads").get() as { count: number }).count;
      target.prepare("INSERT INTO bot_state(key,data) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data").run(
        PLUGIN_MIGRATION_STATE_KEY,
        JSON.stringify(migrationMeta),
      );
      return { botCount, bindingCount };
    }).immediate();
    if (existsSync(stateStaging)) {
      const stateDest = join(targetDir, "state");
      mkdirSync(stateDest, { recursive: true, mode: 0o700 });
      const pendingPath = join(targetDir, `state-migration-pending-${Date.now()}`);
      try {
        cpSync(stateStaging, pendingPath, { recursive: true });
      } catch (pendingError) {
        preserveScratch = true;
        throw new Error(stateCopyFailureMessage(stateStaging, pendingError));
      }
      try {
        cpSync(pendingPath, stateDest, { recursive: true, force: true });
        rmSync(pendingPath, { recursive: true, force: true });
      } catch (stateError) {
        throw new Error(stateCopyFailureMessage(pendingPath, stateError));
      }
    }
    const copiedStateBots = existsSync(stateStaging) ? summary.botCount : 0;
    return { sourcePluginId, botCount: summary.botCount, bindingCount: summary.bindingCount, copiedStateBots };
  } finally {
    legacy?.close();
    if (!preserveScratch) rmSync(scratchDir, { recursive: true, force: true });
  }
}
