import type { ComponentType } from "react";
import { renderSlot as renderSdkSlot } from "@get-bb/plugin-sdk/testing/app";
import type { RenderSlotOptions } from "@get-bb/plugin-sdk/testing/app";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";

type LoadedApp = {
  navPanels: Array<{
    id: string;
    title: string;
    path: string;
    experimental_sidebar?: ComponentType<{ subPath: string }>;
    component: ComponentType<{ subPath: string }>;
    experimental_useBadge?: () => import("@get-bb/plugin-sdk/app").ExperimentalBadge | null;
  }>;
  threadLists: unknown[];
};

export function botsNavPanel(app: LoadedApp) {
  const panel = app.navPanels.find((entry) => entry.id === "bots");
  if (!panel) throw new Error("bots nav panel is not registered");
  return panel;
}

export function botsSidebarComponent(app: LoadedApp) {
  const sidebar = botsNavPanel(app).experimental_sidebar;
  if (!sidebar) throw new Error("bots nav panel has no experimental_sidebar");
  return sidebar;
}

export function renderBotsSidebar(app: LoadedApp, subPath = "", options: RenderSlotOptions = {}) {
  return renderSlot({ component: botsSidebarComponent(app) }, { subPath }, options);
}

// The SDK deliberately doesn't emulate BB's registered thread actions. Supply
// explicit test doubles; lifecycle tests control the resulting sidebar snapshot.
export function renderSlot<Props extends object>(registration: { component: ComponentType<Props> }, props: Props, options: RenderSlotOptions = {}) {
  const nativeActionCalls: Array<{ key: string; threadId: string }> = [];
  const slot = renderSdkSlot(registration, props, {
    ...options,
    sdk: { ...options.sdk, threads: {
      update: async ({ threadId, title }) => makeThreadResponse({ id: threadId, title }),
      ...options.sdk?.threads,
    } },
    threadActions: options.threadActions ?? ((thread, { requestRename }) => [
      { key: "bb--core/rename", pluginId: "bb--core", group: "settings", action: { label: "Rename…", icon: "Pencil", run: async () => requestRename(thread.id) } },
      ...[
        ["open-in-split", "Open in split"],
        [thread.isUnread ? "mark-read" : "mark-unread", thread.isUnread ? "Mark as read" : "Mark as unread"],
        ["archive", "Archive conversation"],
      ].map(([id, label]) => ({
        key: `bb--core/${id}`, pluginId: "bb--core", group: "lifecycle",
        action: { label: label!, icon: "Archive" as const, run: async () => { nativeActionCalls.push({ key: `bb--core/${id}`, threadId: thread.id }); } },
      })),
    ]),
  });
  return Object.assign(slot, { nativeActionCalls });
}
