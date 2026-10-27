import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  experimental_useSidebarThreads,
  useRealtime,
  useRpc,
  type ExperimentalBadge,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { conversationStatus } from "../components/conversation-status-icon";
import type { rpcContract } from "../contract";
import { conversationOwners } from "./conversations";

function useBotThreadBindings() {
  const rpc = useRpc<typeof rpcContract>();
  const [threadBindings, setThreadBindings] = useState<Array<{ threadId: string; botId: string }>>([]);
  const [loaded, setLoaded] = useState(false);
  const refreshSequence = useRef(0);
  const refresh = useCallback(() => {
    const sequence = ++refreshSequence.current;
    return rpc.call("bots_list").then(
      (result) => {
        if (sequence !== refreshSequence.current) return;
        setThreadBindings(result.threadBindings);
        setLoaded(true);
      },
      () => {
        if (sequence !== refreshSequence.current) return;
        setLoaded(true);
      },
    );
  }, [rpc]);
  useEffect(() => {
    void refresh();
    return () => {
      refreshSequence.current++;
    };
  }, [refresh]);
  useRealtime("project-bots-changed", refresh);
  return { threadBindings, loaded };
}

function isWaitingForInput(thread: PluginSidebarThread): boolean {
  return thread.hasPendingInteraction || thread.indicator === "waiting-for-input";
}

export function useBotsNavBadge(): ExperimentalBadge | null {
  const sidebar = experimental_useSidebarThreads();
  const { threadBindings, loaded } = useBotThreadBindings();
  const threads = sidebar.status === "ready" ? sidebar.threads : [];
  const owners = useMemo(() => conversationOwners(threads, threadBindings), [threads, threadBindings]);
  const botOwned = useMemo(
    () => threads.filter((thread) => !thread.isArchived && owners.has(thread.id)),
    [threads, owners],
  );

  if (sidebar.status !== "ready" || !loaded) return null;

  const waiting = botOwned.filter(isWaitingForInput).length;
  if (waiting > 0) {
    const label = waiting === 1
      ? "1 conversation waiting for your input"
      : `${waiting} conversations waiting for your input`;
    return { count: waiting, tone: "warning", label };
  }

  const unreadErrors = botOwned.filter(
    (thread) => thread.isUnread && conversationStatus(thread).state === "error",
  ).length;
  if (unreadErrors > 0) {
    const label = unreadErrors === 1
      ? "1 unread conversation with an error"
      : `${unreadErrors} unread conversations with errors`;
    return { tone: "critical", label };
  }

  return null;
}
