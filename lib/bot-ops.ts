/** Bot registry RPC implementations; server.ts registers hooks and wires these handlers. */
import { createHash, randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { z } from "zod";
import type { BotMetadata, rpcContract } from "../contract";
import { EMPTY_HASHES, nextTimestamp, type BotStore } from "./bot-store";
import { SIDEBAR_MIGRATION_PENDING_CREATE_ERROR, sidebarMigrationPending } from "./migrate-bots";
import { applyState, BotStateConflictError, type PrivateBotState, stateContent } from "./private-state";

const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");

export type SerialFn = <T>(key: string, operation: () => Promise<T>) => Promise<T>;

export type BotOpsDeps = {
  bb: BbPluginApi;
  store: BotStore;
  state: PrivateBotState;
  publish: () => void;
  serial: SerialFn;
  importLegacy: () => Promise<string[]>;
  personalProjectId: () => Promise<string>;
  validateLinks: (ids: string[]) => Promise<void>;
  validateSection: (id: string | null) => void;
  validateConversationProject: (bot: BotMetadata, projectId: string) => Promise<void>;
};

export function createBotOps(deps: BotOpsDeps) {
  const { bb, store, state, publish, serial, importLegacy, personalProjectId, validateLinks, validateSection, validateConversationProject } = deps;

  async function resolveOwner(threadId: string, persist = true): Promise<string | null> {
    const chain: string[] = [];
    let current: string | null = threadId;
    let botId: string | null = null;
    while (current && !chain.includes(current)) {
      const explicit = store.owner(current);
      if (explicit) { botId = explicit; break; }
      const thread = await bb.sdk.threads.get({ threadId: current });
      chain.push(current);
      botId = (thread.parentThreadId && store.owner(thread.parentThreadId)) || (thread.sourceThreadId && store.owner(thread.sourceThreadId)) || null;
      if (botId) break;
      current = thread.parentThreadId ?? thread.sourceThreadId;
    }
    if (botId && persist) for (const id of chain) store.bind(id, botId);
    return botId;
  }

  function saveBotIdentity({ botId, expectedUpdatedAt, expectedStateHashes, ownedProjectIds, memory, settings, ...fields }: z.infer<typeof rpcContract.bot_update.input>) {
    return serial("registry", () => serial(botId, async () => {
      const bot = await state.prepare(botId);
      if (bot.updatedAt !== expectedUpdatedAt) throw new Error("Bot changed while editing. Reopen the editor or read identity again to avoid overwriting newer changes.");
      if (JSON.stringify(fields.linkedProjectIds) !== JSON.stringify(bot.linkedProjectIds)) await validateLinks(fields.linkedProjectIds);
      if (ownedProjectIds) {
        const existingOwned = new Set(store.ownedProjects(botId));
        await validateLinks(ownedProjectIds.filter((id) => !existingOwned.has(id)));
      }
      if (fields.hostId !== undefined && fields.hostId !== bot.hostId && !(await bb.sdk.hosts.list()).some((host) => host.id === fields.hostId)) throw new Error("Choose an enrolled execution machine");
      validateSection(fields.sectionId);
      const next = store.mutateWithProjects(botId, (current) => {
        if (current.updatedAt !== expectedUpdatedAt) throw new Error("Bot changed while editing. Read the current identity before saving.");
        let next = { ...current, ...fields };
        if (memory !== undefined) next = applyState(next, "MEMORY.md", memory);
        if (settings !== undefined) next = applyState(next, "settings.json", stateContent({ ...next, settings }, "settings.json"));
        for (const file of ["SOUL.md", "MEMORY.md", "settings.json"] as const) {
          if (stateContent(next, file) === stateContent(current, file)) continue;
          if (current.stateHashes[file] !== expectedStateHashes[file]) throw new BotStateConflictError(`${file} changed while editing. Read the current state before saving.`);
        }
        return {
          ...next,
          stateHashes: {
            ...current.stateHashes,
            "SOUL.md": sha256(next.soul),
            ...(memory !== undefined ? { "MEMORY.md": sha256(next.memory) } : {}),
            ...(settings !== undefined ? { "settings.json": sha256(stateContent(next, "settings.json")) } : {}),
          },
          updatedAt: nextTimestamp(current.updatedAt),
        };
      }, ownedProjectIds);
      await state.mirror(next); publish(); return next;
    }));
  }

  async function updateProjectRole(botId: string, action: "join" | "leave" | "own" | "release", projectId: string) {
    return serial("registry", () => serial(botId, async () => {
      store.require(botId);
      if (action === "join" || action === "own") await validateLinks([projectId]);
      const result = store.changeProjectRole(botId, projectId, action);
      if (result.changed) { await state.mirror(result.bot); publish(); }
      return result;
    }));
  }

  async function createBot({ name, role, hostId, avatar, sectionId, linkedProjectIds, ownedProjectIds, soul, memory, settings, launchPreset }: z.infer<typeof rpcContract.bot_create.input>) {
    return serial("registry", async () => {
      if (sidebarMigrationPending(bb, store)) throw new Error(SIDEBAR_MIGRATION_PENDING_CREATE_ERROR);
      await importLegacy(); await validateLinks(linkedProjectIds); if (ownedProjectIds) await validateLinks(ownedProjectIds); validateSection(sectionId);
      if (!(await bb.sdk.hosts.list()).some((host) => host.id === hostId)) throw new Error("Choose an enrolled execution machine");
      const id = `bot_${randomUUID().replaceAll("-", "")}`;
      let created: BotMetadata = { id, name, role, hostId, stateReady: true, legacyHomeProjectId: null, avatar, sectionId, linkedProjectIds, soul, agents: "", memory: "", settings: {}, stateHashes: { ...EMPTY_HASHES }, order: store.list().length, mainThreadId: null, hiddenUntilActivity: false, hiddenAt: null, updatedAt: Date.now(), legacyProjectId: null };
      if (memory !== undefined) created = applyState(created, "MEMORY.md", memory);
      if (launchPreset !== undefined) created.launchPreset = launchPreset;
      if (settings !== undefined) created = applyState(created, "settings.json", stateContent({ ...created, settings }, "settings.json"));
      store.saveWithProjects(created, ownedProjectIds);
      const ready = await state.prepare(id); publish(); return ready;
    });
  }

  async function createSection(name: string) {
    return serial("registry", async () => {
      const saved = store.sections();
      const section = { id: randomUUID(), name, order: saved.length };
      store.saveSections([...saved, section]);
      publish();
      return section;
    });
  }

  async function startConversation({ botId, request, makeMain }: z.infer<typeof rpcContract.conversation_create.input>) {
    if (request.projectId !== await personalProjectId()) await updateProjectRole(botId, "join", request.projectId);
    return serial(botId, async () => {
      const bot = await state.prepare(botId);
      await validateConversationProject(bot, request.projectId);
      const token = randomUUID(); store.stageStart(token, botId, request.projectId);
      const thread = await bb.sdk.threads.spawn({ ...request, input: [...request.input, { type: "text", text: `[bb-bot-start:${token}]\nThis conversation belongs to bot ${bot.name}. Its identity and memory are embedded and managed by bot_read_state / bot_update_state, not files in the working directory.`, mentions: [], visibility: "agent-only" }] });
      store.bind(thread.id, botId); store.cancelStart(token);
      if (makeMain || !store.require(botId).mainThreadId) { const latest = store.require(botId); store.save({ ...latest, mainThreadId: thread.id, updatedAt: nextTimestamp(latest.updatedAt) }); }
      publish(); return { threadId: thread.id };
    });
  }

  return { resolveOwner, saveBotIdentity, updateProjectRole, createBot, createSection, startConversation };
}
