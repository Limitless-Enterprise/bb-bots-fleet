import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  experimental_useSidebarThreads,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type {
  PluginAppBuilder,
  PluginThreadActionItemInput,
  PluginThreadActionRegistration,
} from "@get-bb/plugin-sdk/app";
import type { BotMetadata, BotSection, rpcContract } from "../contract";
import { botsInSidebarOrder } from "./bots-sidebar-order";
import { botsThreadSubPath } from "./bots-panel";
import { conversationOwners } from "./conversations";

export const ASSIGN_TO_BOT_THREAD_ACTION_ID = "assign-to-bot";
export const ASSIGN_TO_BOT_THREAD_ACTION_GROUP = "5_bots";

export type AssignToBotThreadActionData = {
  bots: BotMetadata[];
  sections: BotSection[];
  threadBindings: Array<{ threadId: string; botId: string }>;
  threads: ReturnType<typeof experimental_useSidebarThreads>["threads"];
  reservedProjectIds: string[];
  loaded: boolean;
  rpc: ReturnType<typeof useRpc<typeof rpcContract>>;
};

function useAssignToBotData(): AssignToBotThreadActionData {
  const rpc = useRpc<typeof rpcContract>();
  const sidebar = experimental_useSidebarThreads();
  const [bots, setBots] = useState<BotMetadata[]>([]);
  const [sections, setSections] = useState<BotSection[]>([]);
  const [threadBindings, setThreadBindings] = useState<Array<{ threadId: string; botId: string }>>([]);
  const [loaded, setLoaded] = useState(false);
  const [reservedProjectIds, setReservedProjectIds] = useState<string[]>([]);
  const refreshSequence = useRef(0);
  const connectionState = useRealtimeConnectionState();
  const previousConnection = useRef(connectionState);
  const refresh = useCallback(() => {
    const sequence = ++refreshSequence.current;
    return rpc.call("bots_list").then(
      (result) => {
        if (sequence !== refreshSequence.current) return;
        setBots(result.bots);
        setSections(result.sections);
        setThreadBindings(result.threadBindings);
        setReservedProjectIds(result.reservedProjectIds ?? []);
        setLoaded(true);
      },
      () => {
        if (sequence !== refreshSequence.current) return;
        setLoaded(true);
      },
    );
  }, [rpc]);
  useEffect(() => { void refresh(); return () => { refreshSequence.current++; }; }, [refresh]);
  useEffect(() => {
    if (connectionState === "connected" && previousConnection.current !== "connected") void refresh();
    previousConnection.current = connectionState;
  }, [connectionState, refresh]);
  useRealtime("project-bots-changed", refresh);
  return { bots, sections, threadBindings, threads: sidebar.threads, reservedProjectIds, loaded, rpc };
}

export function assignToBotThreadActionItem(
  input: PluginThreadActionItemInput<AssignToBotThreadActionData>,
): ReturnType<PluginThreadActionRegistration<AssignToBotThreadActionData>["item"]> {
  const { thread, data, navigate } = input;
  if (thread.archivedAt) return null;
  if (!data.loaded || data.bots.length === 0) return null;
  if (thread.projectId && data.reservedProjectIds.includes(thread.projectId)) return null;
  const owners = conversationOwners(data.threads, data.threadBindings);
  if (owners.has(thread.id)) return null;

  const choices = botsInSidebarOrder(data.bots, data.sections).map(({ bot, sectionLabel }) => ({
    id: bot.id,
    label: `${bot.name} · ${sectionLabel}`,
  }));

  return {
    label: "Assign to bot",
    icon: "Bot",
    choices: { heading: "Assign to bot", items: choices },
    run: async ({ value: botId }) => {
      if (!botId) return;
      try {
        await data.rpc.call("conversation_assign", { botId, threadId: thread.id });
        const botName = data.bots.find((bot) => bot.id === botId)?.name ?? "bot";
        toast.success(`Conversation assigned to ${botName}`, {
          action: {
            label: "View",
            onClick: () => navigate.toPluginPanel("bots", { subPath: botsThreadSubPath(thread.id) }),
          },
        });
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : String(cause));
      }
    },
  };
}

export function registerAssignToBotThreadAction(app: PluginAppBuilder): void {
  app.slots.experimental_threadAction<AssignToBotThreadActionData>({
    id: ASSIGN_TO_BOT_THREAD_ACTION_ID,
    title: "Assign to bot",
    icon: "Bot",
    group: ASSIGN_TO_BOT_THREAD_ACTION_GROUP,
    useData: () => useAssignToBotData(),
    item: assignToBotThreadActionItem,
  });
}
