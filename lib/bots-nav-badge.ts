import {
  experimental_useSidebarThreads,
  type ExperimentalBadge,
} from "@get-bb/plugin-sdk/app";
import { conversationStatus } from "../components/conversation-status-icon";

export function useBotsNavBadge(): ExperimentalBadge | null {
  const sidebar = experimental_useSidebarThreads();
  if (sidebar.status !== "ready") return null;

  const visible = sidebar.threads.filter((thread) => !thread.isArchived);
  const waiting = visible.filter(
    (thread) => thread.hasPendingInteraction || thread.indicator === "waiting-for-input",
  ).length;
  if (waiting > 0) {
    const label = waiting === 1
      ? "1 conversation waiting for your input"
      : `${waiting} conversations waiting for your input`;
    return { count: waiting, tone: "warning", label };
  }

  const unreadErrors = visible.filter(
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
