// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import {
  ASSIGN_TO_BOT_THREAD_ACTION_GROUP,
  ASSIGN_TO_BOT_THREAD_ACTION_ID,
  assignToBotThreadActionItem,
  type AssignToBotThreadActionData,
} from "../lib/assign-to-bot-thread-action";
import { bot, personalProjectId, thread } from "./fixtures";
import type { PluginThreadActionTarget } from "@get-bb/plugin-sdk/app";

const app = await loadPluginApp(() => import("../app"));

function target(id: string, overrides: Partial<PluginThreadActionTarget> = {}): PluginThreadActionTarget {
  const row = thread(id, 1, overrides as never);
  return {
    id: row.id,
    projectId: row.projectId,
    parentThreadId: row.parentThreadId,
    archivedAt: row.archivedAt,
    pinnedAt: row.pinnedAt,
    sectionId: row.sectionId,
    isUnread: row.isUnread,
    status: row.status,
    environment: row.environment?.id ? { id: row.environment.id, path: row.environment.path } : null,
    ...overrides,
  };
}

describe("assign-to-bot thread action registration", () => {
  it("registers assign-to-bot after bb groups", () => {
    const registration = app.threadActions.find((entry) => entry.id === ASSIGN_TO_BOT_THREAD_ACTION_ID);
    expect(registration?.title).toBe("Assign to bot");
    expect(registration?.group).toBe(ASSIGN_TO_BOT_THREAD_ACTION_GROUP);
    expect(registration!.group! > "4_lifecycle").toBe(true);
  });
});

describe("assignToBotThreadActionItem", () => {
  const baseData: AssignToBotThreadActionData = {
    loaded: true,
    bots: [bot],
    sections: [],
    threadBindings: [{ threadId: "owned", botId: bot.id }],
    threads: [thread("owned", 1), thread("free", 2, { projectId: personalProjectId })],
    rpc: { call: vi.fn(async () => ({})) } as AssignToBotThreadActionData["rpc"],
  };

  it("hides for bot-owned, archived, and empty-bot states", () => {
    expect(assignToBotThreadActionItem({
      thread: target("owned"),
      data: baseData,
      sdk: {} as never,
      navigate: { toPluginPanel: vi.fn() } as never,
    })).toBeNull();
    expect(assignToBotThreadActionItem({
      thread: target("free", { archivedAt: 1 }),
      data: baseData,
      sdk: {} as never,
      navigate: { toPluginPanel: vi.fn() } as never,
    })).toBeNull();
    expect(assignToBotThreadActionItem({
      thread: target("free"),
      data: { ...baseData, bots: [] },
      sdk: {} as never,
      navigate: { toPluginPanel: vi.fn() } as never,
    })).toBeNull();
  });

  it("lists every bot without project-membership filtering", () => {
    const unlinked = { ...bot, id: "unlinked", name: "Unlinked bot", linkedProjectIds: [] };
    const legacy = { ...bot, id: "legacy", name: "Legacy owner", legacyHomeProjectId: "project", linkedProjectIds: [] };
    const action = assignToBotThreadActionItem({
      thread: target("free"),
      data: { ...baseData, bots: [bot, unlinked, legacy] },
      sdk: {} as never,
      navigate: { toPluginPanel: vi.fn() } as never,
    });
    expect(action?.choices?.items.map((item) => item.label)).toEqual([
      `${bot.name} · Main`,
      "Unlinked bot · Main",
      "Legacy owner · Main",
    ]);
  });

  it("lists bots with section labels and assigns on run", async () => {
    const navigate = { toPluginPanel: vi.fn() };
    const action = assignToBotThreadActionItem({
      thread: target("free"),
      data: baseData,
      sdk: {} as never,
      navigate: navigate as never,
    });
    expect(action?.choices?.items).toEqual([{ id: bot.id, label: `${bot.name} · Main` }]);
    const success = vi.spyOn(toast, "success");
    await action?.run?.({ value: bot.id, requestRename: vi.fn() });
    expect(baseData.rpc.call).toHaveBeenCalledWith("conversation_assign", { botId: bot.id, threadId: "free" });
    const view = success.mock.calls[0]?.[1]?.action as { label: string; onClick: () => void };
    expect(view.label).toBe("View");
    view.onClick();
    expect(navigate.toPluginPanel).toHaveBeenCalledWith("bots", { subPath: "thread/free" });
  });
});
