import { readFileSync } from "node:fs";
import type { PluginCliContext } from "@get-bb/plugin-sdk";
import type { BotMetadata } from "../contract";
import type { BotMemory } from "./bot-memory";
import type { BotStore } from "./bot-store";
import { botMemoryKindSchema } from "./bot-memory-kinds";

const USAGE = `bb bots memory <bot-id-or-name> list [--json]
bb bots memory <bot> read <entry-id> [--json]
bb bots memory <bot> edit <entry-id> --from <file>
bb bots memory <bot> export --to <directory>`;

function assertOperatorShell(ctx: PluginCliContext) {
  if (ctx.threadId) throw new Error("bb bots memory is operator-only and cannot run from a BB thread");
}

function recipient(bots: BotMetadata[], selector: string) {
  const byId = bots.find((bot) => bot.id === selector);
  if (byId) return byId;
  const matches = bots.filter((bot) => bot.name === selector);
  if (matches.length > 1) throw new Error("Several bots have that name. Use an exact bot ID from bb bots list.");
  if (!matches.length) throw new Error("Bot not found. Use bb bots list for IDs and exact names.");
  return matches[0]!;
}

export async function runBotsMemoryCommand(argv: string[], ctx: PluginCliContext, store: BotStore, memory: BotMemory) {
  assertOperatorShell(ctx);
  if (!argv.length || argv[0] === "--help" || argv[0] === "help") return { exitCode: 0, stdout: USAGE };
  const json = argv.includes("--json");
  const selector = argv[0];
  if (!selector) throw new Error(`Missing bot selector\n${USAGE}`);
  const bot = recipient(store.list(), selector);
  const rest = argv.slice(1).filter((arg) => arg !== "--json");
  const command = rest[0];
  if (!command) throw new Error(`Missing memory subcommand\n${USAGE}`);
  if (command === "list") {
    if (rest.length !== 1) throw new Error(`Unexpected arguments\n${USAGE}`);
    const entries = memory.listIndex(bot.id);
    return { exitCode: 0, stdout: json ? JSON.stringify({ botId: bot.id, entries }) : entries.map((entry) => `${entry.id}\t${entry.title}\t${entry.kind}\t${entry.hook}`).join("\n") || "No memory entries." };
  }
  if (command === "read") {
    const entryId = rest[1];
    if (!entryId || rest.length !== 2) throw new Error(`Usage: bb bots memory <bot> read <entry-id>\n${USAGE}`);
    const entry = memory.readEntry(bot.id, entryId);
    const history = memory.readHistory(entryId);
    return { exitCode: 0, stdout: json ? JSON.stringify({ entry, history }) : `${entry.title}\n${entry.body}\n---\nsha256: ${entry.sha256}` };
  }
  if (command === "edit") {
    const entryId = rest[1];
    const fromIndex = rest.indexOf("--from");
    const fromPath = fromIndex >= 0 ? rest[fromIndex + 1] : undefined;
    if (!entryId || !fromPath || rest.length < 4) throw new Error(`Usage: bb bots memory <bot> edit <entry-id> --from <file>\n${USAGE}`);
    const raw = readFileSync(fromPath, "utf8");
    let payload: { title?: string; kind?: string; importance?: number; body?: string; reviewBy?: string | null; expectedSha256?: string };
    try {
      payload = JSON.parse(raw) as typeof payload;
    } catch {
      payload = { body: raw };
    }
    const current = memory.readEntry(bot.id, entryId);
    const body = payload.body ?? current.body;
    const written = memory.writeEntry(bot.id, {
      id: entryId,
      title: payload.title ?? current.title,
      kind: botMemoryKindSchema.parse(payload.kind ?? current.kind),
      importance: payload.importance ?? current.importance,
      body,
      reviewBy: payload.reviewBy === undefined ? current.reviewBy : payload.reviewBy,
      expectedSha256: payload.expectedSha256 ?? current.sha256,
    }, "operator");
    return { exitCode: 0, stdout: json ? JSON.stringify(written) : `Updated ${written.id}` };
  }
  if (command === "export") {
    const toIndex = rest.indexOf("--to");
    const directory = toIndex >= 0 ? rest[toIndex + 1] : undefined;
    if (!directory || rest.length < 3) throw new Error(`Usage: bb bots memory <bot> export --to <directory>\n${USAGE}`);
    memory.exportToDirectory(bot.id, directory);
    return { exitCode: 0, stdout: json ? JSON.stringify({ botId: bot.id, directory }) : `Exported memory for ${bot.id} to ${directory}` };
  }
  throw new Error(`Unknown memory subcommand: ${command}\n${USAGE}`);
}
