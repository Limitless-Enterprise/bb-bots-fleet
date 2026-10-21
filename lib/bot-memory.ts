import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse } from "node:path";
import type { BotMemoryKind } from "./bot-memory-kinds";
import { botMemoryKindSchema } from "./bot-memory-kinds";
import { BotStateConflictError } from "./private-state";
import type { BotStore } from "./bot-store";

export const MEMORY_ENTRY_MAX_CHARS = 4000;
export const MEMORY_MAX_LIVE_ENTRIES = 300;

const hash = (content: string) => createHash("sha256").update(content, "utf8").digest("hex");

type DbEntry = {
  id: string;
  bot_id: string;
  title: string;
  kind: string;
  importance: number;
  body: string;
  review_by: string | null;
  sha256: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
};

export type BotMemoryIndexLine = {
  id: string;
  title: string;
  kind: BotMemoryKind;
  importance: number;
  hook: string;
  reviewBy: string | null;
  updatedAt: number;
};

export type BotMemoryEntry = {
  id: string;
  title: string;
  kind: BotMemoryKind;
  importance: number;
  body: string;
  reviewBy: string | null;
  sha256: string;
  createdAt: number;
  updatedAt: number;
};

export type BotMemoryHistoryRow = { revision: number; body: string; actor: string; at: number };

function hook(body: string) {
  const line = body.split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? "";
  return line.slice(0, 120);
}

function assertId(id: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new Error("Invalid bot ID");
}

function missing(error: unknown) { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }

function assertDirectory(path: string) {
  if (path !== parse(path).root) assertDirectory(dirname(path));
  if (!lstatSync(path).isDirectory()) throw new Error("Private memory export requires a real directory");
}

function ensureDirectory(path: string) {
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  assertDirectory(path);
}

function privateMode(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { if ((fstatSync(fd).mode & 0o777) !== 0o700) fchmodSync(fd, 0o700); } finally { closeSync(fd); }
}

function atomicExport(directory: string, file: string, content: string) {
  const destination = join(directory, file);
  const temporary = join(directory, `.export-${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { fchmodSync(fd, 0o600); writeFileSync(fd, content, "utf8"); } finally { closeSync(fd); }
    renameSync(temporary, destination);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (!missing(error)) throw error; }
  }
}

function mapEntry(row: DbEntry): BotMemoryEntry {
  return {
    id: row.id,
    title: row.title,
    kind: botMemoryKindSchema.parse(row.kind),
    importance: row.importance,
    body: row.body,
    reviewBy: row.review_by,
    sha256: row.sha256,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createBotMemory(bb: BbPluginApi, store: BotStore, publish: () => void) {
  const connection = bb.storage.database();

  function botDirectory(botId: string) {
    assertId(botId);
    if (!isAbsolute(store.databasePath)) throw new Error("Private memory requires an absolute storage database path");
    return join(dirname(store.databasePath), "state", botId, "memory");
  }

  function liveCount(botId: string) {
    return (connection.prepare("SELECT COUNT(*) AS count FROM bot_memory_entries WHERE bot_id = ? AND deleted_at IS NULL").get(botId) as { count: number }).count;
  }

  function nextRevision(entryId: string) {
    const row = connection.prepare("SELECT MAX(revision) AS revision FROM bot_memory_history WHERE entry_id = ?").get(entryId) as { revision: number | null };
    return (row.revision ?? 0) + 1;
  }

  function recordHistory(entryId: string, body: string, actor: string) {
    const revision = nextRevision(entryId);
    connection.prepare("INSERT INTO bot_memory_history(entry_id, revision, body, actor, at) VALUES (?,?,?,?,?)").run(entryId, revision, body, actor, Date.now());
  }

  function mirrorExports(botId: string) {
    try {
      const path = botDirectory(botId);
      const root = dirname(path);
      ensureDirectory(root);
      ensureDirectory(path);
      privateMode(dirname(root));
      privateMode(root);
      privateMode(path);
      const rows = connection.prepare("SELECT id, title, kind, importance, body, review_by, sha256, created_at, updated_at FROM bot_memory_entries WHERE bot_id = ? AND deleted_at IS NULL ORDER BY id").all(botId) as Omit<DbEntry, "bot_id" | "deleted_at">[];
      const live = new Set(rows.map((row) => row.id));
      for (const name of readdirSync(path)) {
        if (name.startsWith(".") || !name.endsWith(".json")) continue;
        const id = name.slice(0, -5);
        if (!live.has(id)) {
          try { unlinkSync(join(path, name)); } catch (error) { if (!missing(error)) throw error; }
        }
      }
      for (const row of rows) {
        atomicExport(path, `${row.id}.json`, `${JSON.stringify({
          id: row.id,
          title: row.title,
          kind: row.kind,
          importance: row.importance,
          body: row.body,
          reviewBy: row.review_by,
          sha256: row.sha256,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }, null, 2)}\n`);
      }
      const historyDir = join(path, "history");
      ensureDirectory(historyDir);
      for (const name of readdirSync(historyDir)) {
        if (name.startsWith(".") || !name.endsWith(".json")) continue;
        const id = name.slice(0, -5);
        if (!live.has(id)) {
          try { unlinkSync(join(historyDir, name)); } catch (error) { if (!missing(error)) throw error; }
        }
      }
      for (const entryId of live) {
        const history = readHistory(entryId);
        atomicExport(historyDir, `${entryId}.json`, `${JSON.stringify(history, null, 2)}\n`);
      }
    } catch {
      // Best-effort export; SQLite remains canonical.
    }
  }

  function requireLive(botId: string, entryId: string): DbEntry {
    const row = connection.prepare("SELECT * FROM bot_memory_entries WHERE id = ? AND bot_id = ? AND deleted_at IS NULL").get(entryId, botId) as DbEntry | undefined;
    if (!row) throw new Error("Memory entry not found");
    return row;
  }

  function listIndex(botId: string, kind?: BotMemoryKind, limit = 50): BotMemoryIndexLine[] {
    store.require(botId);
    const rows = (kind
      ? connection.prepare("SELECT id, title, kind, importance, body, review_by, updated_at FROM bot_memory_entries WHERE bot_id = ? AND deleted_at IS NULL AND kind = ? ORDER BY updated_at DESC LIMIT ?").all(botId, kind, limit)
      : connection.prepare("SELECT id, title, kind, importance, body, review_by, updated_at FROM bot_memory_entries WHERE bot_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?").all(botId, limit)) as Pick<DbEntry, "id" | "title" | "kind" | "importance" | "body" | "review_by" | "updated_at">[];
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      kind: botMemoryKindSchema.parse(row.kind),
      importance: row.importance,
      hook: hook(row.body),
      reviewBy: row.review_by,
      updatedAt: row.updated_at,
    }));
  }

  function readEntry(botId: string, entryId: string): BotMemoryEntry {
    return mapEntry(requireLive(botId, entryId));
  }

  function readHistory(entryId: string): BotMemoryHistoryRow[] {
    return (connection.prepare("SELECT revision, body, actor, at FROM bot_memory_history WHERE entry_id = ? ORDER BY revision").all(entryId) as BotMemoryHistoryRow[]);
  }

  function search(botId: string, query: string, limit = 20): BotMemoryIndexLine[] {
    store.require(botId);
    const needle = `%${query.trim()}%`;
    const rows = connection.prepare("SELECT id, title, kind, importance, body, review_by, updated_at FROM bot_memory_entries WHERE bot_id = ? AND deleted_at IS NULL AND (title LIKE ? OR body LIKE ?) ORDER BY updated_at DESC LIMIT ?").all(botId, needle, needle, limit) as Pick<DbEntry, "id" | "title" | "kind" | "importance" | "body" | "review_by" | "updated_at">[];
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      kind: botMemoryKindSchema.parse(row.kind),
      importance: row.importance,
      hook: hook(row.body),
      reviewBy: row.review_by,
      updatedAt: row.updated_at,
    }));
  }

  function writeEntry(botId: string, input: {
    id?: string;
    title: string;
    kind: BotMemoryKind;
    importance: number;
    body: string;
    reviewBy: string | null;
    expectedSha256?: string;
  }, actor: "bot" | "operator"): BotMemoryEntry {
    store.require(botId);
    if (input.body.length > MEMORY_ENTRY_MAX_CHARS) throw new Error(`Memory body must be at most ${MEMORY_ENTRY_MAX_CHARS} characters`);
    const now = Date.now();
    const result = connection.transaction(() => {
      if (input.id) {
        const current = requireLive(botId, input.id);
        if (!input.expectedSha256) throw new Error("expectedSha256 is required when updating a memory entry");
        if (current.sha256 !== input.expectedSha256) throw new BotStateConflictError("Memory entry changed. Read it again and retry with its sha256.");
        const nextBody = input.body;
        const nextSha = hash(nextBody);
        if (current.title === input.title && current.kind === input.kind && current.importance === input.importance && current.body === nextBody && current.review_by === input.reviewBy) {
          return mapEntry(current);
        }
        recordHistory(current.id, current.body, actor);
        connection.prepare("UPDATE bot_memory_entries SET title = ?, kind = ?, importance = ?, body = ?, review_by = ?, sha256 = ?, updated_at = ? WHERE id = ? AND bot_id = ?").run(
          input.title, input.kind, input.importance, nextBody, input.reviewBy, nextSha, now, input.id, botId,
        );
        return mapEntry(requireLive(botId, input.id));
      }
      if (liveCount(botId) >= MEMORY_MAX_LIVE_ENTRIES) throw new Error(`This bot already has ${MEMORY_MAX_LIVE_ENTRIES} live memory entries`);
      const id = `mem_${randomUUID()}`;
      const sha256 = hash(input.body);
      connection.prepare("INSERT INTO bot_memory_entries(id, bot_id, title, kind, importance, body, review_by, sha256, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL)").run(
        id, botId, input.title, input.kind, input.importance, input.body, input.reviewBy, sha256, now, now,
      );
      recordHistory(id, input.body, actor);
      return mapEntry(requireLive(botId, id));
    }).immediate();
    mirrorExports(botId);
    publish();
    return result;
  }

  function forgetEntry(botId: string, entryId: string, expectedSha256: string, actor: "bot" | "operator") {
    const result = connection.transaction(() => {
      const current = requireLive(botId, entryId);
      if (current.sha256 !== expectedSha256) throw new BotStateConflictError("Memory entry changed. Read it again and retry with its sha256.");
      recordHistory(entryId, current.body, actor);
      connection.prepare("UPDATE bot_memory_entries SET deleted_at = ?, updated_at = ? WHERE id = ? AND bot_id = ?").run(Date.now(), Date.now(), entryId, botId);
      return { id: entryId, forgotten: true as const };
    }).immediate();
    mirrorExports(botId);
    publish();
    return result;
  }

  function stats(botId: string) {
    store.require(botId);
    const row = connection.prepare("SELECT COUNT(*) AS entries, COALESCE(SUM(LENGTH(body)), 0) AS bytes FROM bot_memory_entries WHERE bot_id = ? AND deleted_at IS NULL").get(botId) as { entries: number; bytes: number };
    return { entries: row.entries, bytes: row.bytes };
  }

  function exportToDirectory(botId: string, directory: string) {
    store.require(botId);
    ensureDirectory(directory);
    privateMode(directory);
    const entries = connection.prepare("SELECT * FROM bot_memory_entries WHERE bot_id = ? AND deleted_at IS NULL ORDER BY id").all(botId) as DbEntry[];
    atomicExport(directory, "index.json", `${JSON.stringify(entries.map((row) => mapEntry(row)), null, 2)}\n`);
    const historyDir = join(directory, "history");
    ensureDirectory(historyDir);
    for (const entry of entries) {
      atomicExport(historyDir, `${entry.id}.json`, `${JSON.stringify(readHistory(entry.id), null, 2)}\n`);
    }
  }

  return {
    listIndex,
    readEntry,
    readHistory,
    search,
    writeEntry,
    forgetEntry,
    stats,
    exportToDirectory,
    mirrorExports,
  };
}

export type BotMemory = ReturnType<typeof createBotMemory>;
