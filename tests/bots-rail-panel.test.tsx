// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import { botsPanelNavigateCall } from "../lib/bots-panel";
import { botsNavPanel, renderBotsSidebar, renderSlot } from "./sidebar-host";
import { bot, personalProjectId, thread } from "./fixtures";

const app = await loadPluginApp(() => import("../app"));
afterEach(cleanup);

describe("bots rail panel registration", () => {
  it("registers navPanel with sidebar and badge hook", () => {
    expect(app.threadLists).toHaveLength(0);
    const panel = botsNavPanel(app);
    expect(panel.title).toBe("Bots");
    expect(panel.path).toBe("bots");
    expect(panel.experimental_sidebar).toBeTypeOf("function");
    expect(panel.experimental_useBadge).toBeTypeOf("function");
  });
});

describe("in-panel navigation", () => {
  it("opens conversations inside the bots panel", async () => {
    const slot = renderBotsSidebar(app, "thread/main", {
      sidebarThreads: {
        projects: [{ id: "project", name: "Test bot", isPersonal: false, href: "/projects/project", settingsHref: "/projects/project/settings" }],
        threads: [thread("main", 1000), thread("0", 100)],
      },
      rpc: {
        bots_list: () => ({
          personalProjectId,
          bots: [bot],
          hosts: [{ id: "host", name: "Local", connected: true }],
          sections: [],
          projects: [{ id: "project", name: "Project" }],
          threadBindings: [{ threadId: "main", botId: bot.id }, { threadId: "0", botId: bot.id }],
          warnings: [],
        }),
      },
    });
    await slot.findByText("Test bot");
    fireEvent.click(slot.getByRole("button", { name: "Expand conversations for Test bot" }));
    fireEvent.click(slot.getByText("Conversation 0"));
    expect(slot.inspection.navigateCalls).toContainEqual(botsPanelNavigateCall("0"));
  });

  it("opens conversations in split with metaKey", async () => {
    const slot = renderBotsSidebar(app, "thread/main", {
      sidebarThreads: {
        projects: [{ id: "project", name: "Test bot", isPersonal: false, href: "/projects/project", settingsHref: "/projects/project/settings" }],
        threads: [thread("main", 1000), thread("0", 100)],
      },
      rpc: {
        bots_list: () => ({
          personalProjectId,
          bots: [bot],
          hosts: [{ id: "host", name: "Local", connected: true }],
          sections: [],
          projects: [{ id: "project", name: "Project" }],
          threadBindings: [{ threadId: "main", botId: bot.id }, { threadId: "0", botId: bot.id }],
          warnings: [],
        }),
      },
    });
    await slot.findByText("Test bot");
    fireEvent.click(slot.getByRole("button", { name: "Expand conversations for Test bot" }));
    fireEvent.click(slot.getByText("Conversation 0"), { metaKey: true });
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toThread",
      threadId: "0",
      options: { split: true },
    });
  });
});

describe("bots page", () => {
  it("shows home actions without a thread subpath", () => {
    const Page = botsNavPanel(app).component;
    const slot = renderSlot({ component: Page }, { subPath: "" }, {
      rpc: {
        bots_list: () => ({
          personalProjectId,
          bots: [],
          hosts: [],
          sections: [],
          projects: [],
          threadBindings: [],
          warnings: [],
        }),
      },
    });
    expect(slot.getByRole("button", { name: "Create bot" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "New chat" })).toBeTruthy();
  });

  it("renders Open in BB for a thread subpath", async () => {
    const Page = botsNavPanel(app).component;
    const slot = renderSlot({ component: Page }, { subPath: "thread/main" }, {
      sidebarThreads: {
        projects: [],
        threads: [thread("main", 1, { title: "Hello thread" })],
      },
      rpc: {
        bots_list: () => ({
          personalProjectId,
          bots: [bot],
          hosts: [],
          sections: [],
          projects: [],
          threadBindings: [{ threadId: "main", botId: bot.id }],
          warnings: [],
        }),
      },
    });
    fireEvent.click(slot.getByRole("button", { name: "Open in BB" }));
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toThread",
      threadId: "main",
      options: { split: false },
    });
    expect(slot.getByTestId("bb-thread-chat")).toBeTruthy();
  });

  it("opens in BB split when Open in BB is clicked with metaKey", async () => {
    const Page = botsNavPanel(app).component;
    const slot = renderSlot({ component: Page }, { subPath: "thread/main" }, {
      sidebarThreads: {
        projects: [],
        threads: [thread("main", 1, { title: "Hello thread" })],
      },
      rpc: {
        bots_list: () => ({
          personalProjectId,
          bots: [bot],
          hosts: [],
          sections: [],
          projects: [],
          threadBindings: [{ threadId: "main", botId: bot.id }],
          warnings: [],
        }),
      },
    });
    fireEvent.click(slot.getByRole("button", { name: "Open in BB" }), { metaKey: true });
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toThread",
      threadId: "main",
      options: { split: true },
    });
  });
});

describe("nav badge hook", () => {
  it("counts conversations waiting for input", () => {
    const badge = botsNavPanel(app).experimental_useBadge!;
    function Probe() {
      const value = badge() as import("@get-bb/plugin-sdk/app").ExperimentalBadge | null;
      return (
        <span data-testid="badge" data-tone={value?.tone ?? ""}>
          {value ? `${value.count ?? "dot"}:${value.label}` : "none"}
        </span>
      );
    }
    const slot = renderSlot({ component: Probe }, {}, {
      sidebarThreads: {
        projects: [],
        threads: [
          thread("waiting", 1, { hasPendingInteraction: true }),
          thread("idle", 2),
        ],
      },
    });
    expect(slot.getByTestId("badge").textContent).toContain("1 conversation waiting");
  });

  it("counts waiting-for-input indicator without pending interaction", () => {
    const badge = botsNavPanel(app).experimental_useBadge!;
    function Probe() {
      const value = badge() as import("@get-bb/plugin-sdk/app").ExperimentalBadge | null;
      return (
        <span data-testid="badge" data-tone={value?.tone ?? ""}>
          {value ? `${value.count ?? "dot"}:${value.label}` : "none"}
        </span>
      );
    }
    const slot = renderSlot({ component: Probe }, {}, {
      sidebarThreads: {
        projects: [],
        threads: [thread("waiting", 1, { indicator: "waiting-for-input" })],
      },
    });
    expect(slot.getByTestId("badge").getAttribute("data-tone")).toBe("warning");
    expect(slot.getByTestId("badge").textContent).toBe("1:1 conversation waiting for your input");
  });

  it("shows critical dot badge for unread error conversations", () => {
    const badge = botsNavPanel(app).experimental_useBadge!;
    function Probe() {
      const value = badge() as import("@get-bb/plugin-sdk/app").ExperimentalBadge | null;
      return (
        <span data-testid="badge" data-tone={value?.tone ?? ""}>
          {value ? `${value.count ?? "dot"}:${value.label}` : "none"}
        </span>
      );
    }
    const slot = renderSlot({ component: Probe }, {}, {
      sidebarThreads: {
        projects: [],
        threads: [thread("err", 1, { isUnread: true, indicator: "unread-error" })],
      },
    });
    expect(slot.getByTestId("badge").getAttribute("data-tone")).toBe("critical");
    expect(slot.getByTestId("badge").textContent).toBe("dot:1 unread conversation with an error");
  });
});
