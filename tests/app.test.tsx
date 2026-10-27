// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import { botsNavPanel, botsSidebarComponent, renderBotsSidebar, renderSlot } from "./sidebar-host"
import { botsPanelNavigateCall } from "../lib/bots-panel";
import { bot, personalProjectId, thread } from "./fixtures";

const app = await loadPluginApp(() => import("../app"));
afterEach(cleanup);

async function mount(withChat = false, status: Partial<ReturnType<typeof thread>> = {}, withHidden = false) {
  const onNavigate = vi.fn();
  const slot = renderBotsSidebar(app, "thread/main", {
    sidebarThreads: {
      projects: [{ id: "project", name: "Test bot", isPersonal: false, href: "/projects/project", settingsHref: "/projects/project/settings" }, ...(withChat ? [{ id: "personal", name: "Personal", isPersonal: true, href: "/projects/project", settingsHref: "/projects/project/settings" }] : []), ...(withHidden ? [{ id: "hidden", name: "Hidden bot", isPersonal: false, href: "/projects/project", settingsHref: "/projects/project/settings" }] : [])],
      threads: [thread("main", 1000), ...Array.from({ length: 10 }, (_, i) => thread(String(i), 100 - i, i === 0 ? status : {})), ...(withChat ? [thread("chat", 200, { ...status, projectId: "personal", environment: null })] : [])],
    },
    rpc: { bots_list: () => ({ personalProjectId, bots: [bot, ...(withHidden ? [{ ...bot, id: "hidden", name: "Hidden bot", mainThreadId: null, hiddenUntilActivity: true, hiddenAt: 10000 }] : [])], hosts: [{ id: "host", name: "Local", connected: true }], sections: [], projects: [{ id: "project", name: "Project" }], threadBindings: ["main", ...Array.from({ length: 10 }, (_, i) => String(i))].map((threadId) => ({ threadId, botId: bot.id })), warnings: [] }), conversation_reorder: () => ({ ok: true }) },
  });
  await slot.findByText("Test bot");
  fireEvent.click(slot.getByRole("button", { name: "Expand conversations for Test bot" }));
  return { slot, onNavigate };
}

describe("Bots sidebar", () => {
  it("counts every top-level conversation in the bot disclosure", async () => {
    const { slot } = await mount();
    const row = slot.getByText("Test bot").closest<HTMLElement>(".project-row")!;
    expect(row.querySelector(".conversation-disclosure")?.textContent).toBe("11");
    expect(slot.container.querySelectorAll("[data-sidebar-thread-id]")).toHaveLength(11);
    expect(slot.getByRole("group", { name: "Conversations for Test bot" })).toBeTruthy();
    expect(slot.inspection.navigateCalls).toEqual([]);
  });
  it("uses an invisible Main section instead of an Unassigned heading", async () => {
    const { slot } = await mount(false, {}, false);
    expect(slot.getByText("Test bot")).toBeTruthy();
    expect(slot.queryByText("Main", { exact: true })).toBeNull();
    expect(slot.queryByText("Unassigned", { exact: true })).toBeNull();
    expect(slot.getByText("Test bot").closest(".bot-section")?.getAttribute("data-section-id")).toBe("unassigned");
  });
  it("has no activity-date labels and puts the hidden toggle below the bots", async () => {
    const { slot } = await mount(true, {}, true);
    expect(slot.queryByText(/^\d{1,2}\/\d{1,2}$/)).toBeNull();
    expect(slot.container.querySelector(".project-date")).toBeNull();
    const toggle = slot.getByRole("button", { name: "1 hidden" });
    expect(toggle.closest(".bots-list-footer")).not.toBeNull();
    const list = slot.container.querySelector(".bot-section")!;
    expect(list.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(toggle);
    expect(slot.getByText("Hidden bot")).toBeTruthy();
  });
  it("shows the ordered roots with only the requested inline archive action", async () => {
    const { slot } = await mount();
    expect(slot.container.querySelectorAll("[data-sidebar-thread-id]")).toHaveLength(11);
    expect(slot.container.querySelectorAll(".thread-row button:not(.conversation-archive), .project-row-actions")).toHaveLength(0);
    expect(slot.container.querySelectorAll(".thread-row .conversation-archive")).toHaveLength(11);
    expect(slot.queryByRole("button", { name: /Other/ })).toBeNull();
    expect(slot.container.querySelectorAll("[data-sidebar-thread-id]")).toHaveLength(11);
    expect(slot.inspection.navigateCalls).toEqual([]);
  });
  it("does not render a Chats pane in the sidebar", async () => {
    const { slot } = await mount(true);
    expect(slot.queryByRole("button", { name: "Chats" })).toBeNull();
    expect(slot.queryByRole("separator", { name: "Resize Chats" })).toBeNull();
    expect(slot.queryByText("Conversation chat")).toBeNull();
  });
  it.each([
    { indicator: "runtime" as const, label: "Working" },
    { indicator: "none" as const, label: "Done" },
  ])("shows $label icons on bot conversations", async ({ indicator, label }) => {
    const { slot } = await mount(false, { indicator });
    const row = slot.container.querySelector<HTMLElement>('[data-sidebar-thread-id="0"]')!;
    expect(within(row).getByRole("img", { name: label })).toBeTruthy();
    expect(row.querySelectorAll(".conversation-status")).toHaveLength(1);
    expect(row.querySelector(".thread-indicator, .thread-branch")).toBeNull();
  });
  it("archives a conversation through the host, not a private RPC", async () => {
    const { slot } = await mount();
    fireEvent.contextMenu(slot.getByText("Conversation 0"));
    fireEvent.click(await slot.findByRole("menuitem", { name: "Archive conversation" }));
    expect(slot.nativeActionCalls).toContainEqual({ key: "bb--core/archive", threadId: "0" });
  });
  it("renames a bot conversation only on explicit Save", async () => {
    const { slot } = await mount(false);
    fireEvent.contextMenu(slot.getByText("Conversation 0"));
    fireEvent.click(await slot.findByRole("menuitem", { name: "Rename…" }));
    const input = await slot.findByRole("textbox", { name: "Name" });
    expect((input as HTMLInputElement).value).toBe("Conversation 0");
    fireEvent.change(input, { target: { value: "  New name  " } });
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
    expect(slot.inspection.navigateCalls).toEqual([]);
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    expect(slot.inspection.sdkCalls).toContainEqual({ method: "threads.update", args: [{ threadId: "0", title: "New name" }] });
  });
  it("offers Move to top instead of Make main", async () => {
    const { slot } = await mount();
    fireEvent.contextMenu(slot.getByText("Conversation 0"));
    fireEvent.click(await slot.findByRole("menuitem", { name: "Move to top" }));
    await waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual({ method: "conversation_reorder", input: { botId: bot.id, threadId: "0", targetThreadId: "main", position: "before" } }));
  });
  it("opens the host worktree composer from the bot without creating a thread yet", async () => {
    const { slot } = await mount();
    fireEvent.contextMenu(slot.getByText("Test bot"));
    fireEvent.click(await slot.findByRole("menuitem", { name: "New conversation in worktree…" }));
    await slot.findByRole("dialog", { name: "New conversation in worktree" });
    expect(slot.getByText("Start in a fresh worktree. Choose the branch and harness before sending.")).toBeTruthy();
    expect(slot.inspection.rpcCalls.some((call) => call.method === "conversation_create")).toBe(false);
    expect(slot.inspection.navigateCalls).toEqual([]);
  });
  it("offers a fresh worktree from an existing conversation", async () => {
    const { slot } = await mount();
    fireEvent.contextMenu(slot.getByText("Conversation 0"));
    fireEvent.click(await slot.findByRole("menuitem", { name: "New conversation in worktree…" }));
    await slot.findByRole("dialog", { name: "New conversation in worktree" });
    expect(slot.getByText("Start in a fresh worktree. Choose the branch and harness before sending.")).toBeTruthy();
  });
});
