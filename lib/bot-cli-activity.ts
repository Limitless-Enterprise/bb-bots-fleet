import type { BbPluginApi, PluginCliContext } from "@get-bb/plugin-sdk";
import type { BotStore } from "./bot-store";
import { conversationRoots, orderConversations } from "./conversation-order";

export type BotCliActivityStatus = "idle" | "working" | "waiting" | "error";

export async function listBotCliActivity(
  bb: BbPluginApi,
  store: BotStore,
  resolveOwner: (threadId: string, persist?: boolean) => Promise<string | null>,
  ctx: PluginCliContext,
) {
  const rank: Record<BotCliActivityStatus, number> = { idle: 0, error: 1, working: 2, waiting: 3 };
  const result = new Map<string, BotCliActivityStatus>();
  const threads: Awaited<ReturnType<typeof bb.sdk.threads.list>> = [];
  for (let offset = 0; ; offset += 100) {
    ctx.signal?.throwIfAborted();
    const page = await bb.sdk.threads.list({ archived: false, includeHidden: true, offset, limit: 100, signal: ctx.signal });
    threads.push(...page);
    if (page.length < 100) break;
  }
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const direct = new Map(store.bindings().map((binding) => [binding.threadId, binding.botId]));
  const botRows = new Map<string, typeof threads>();
  for (const thread of threads) {
    if (thread.archivedAt || thread.deletedAt) continue;
    let id: string | null = thread.id;
    let owner: string | undefined;
    const visited = new Set<string>();
    while (id && !visited.has(id)) {
      visited.add(id);
      owner = direct.get(id);
      if (owner) break;
      const ancestor = byId.get(id);
      if (!ancestor) { owner = await resolveOwner(id, false) ?? undefined; break; }
      id = ancestor.parentThreadId ?? ancestor.sourceThreadId;
    }
    if (!owner) continue;
    if (thread.visibility !== "hidden") {
      const rows = botRows.get(owner) ?? [];
      rows.push(thread);
      botRows.set(owner, rows);
    }
    const runtime = thread.runtime.displayStatus;
    const status: BotCliActivityStatus = thread.hasPendingInteraction || runtime === "waiting-for-host" ? "waiting"
      : ["active", "pending", "provisioning", "starting", "stopping"].includes(runtime) || Object.values(thread.activity ?? {}).some((count) => count > 0) ? "working"
      : runtime === "error" || thread.queuedWork === "failed" ? "error" : "idle";
    if (rank[status] > rank[result.get(owner) ?? "idle"]) result.set(owner, status);
  }
  const firstThreads = new Map(store.list().map((bot) => [bot.id, conversationRoots(orderConversations(botRows.get(bot.id) ?? [], bot.threadOrder))[0]?.id]));
  return { activity: result, firstThreads };
}
