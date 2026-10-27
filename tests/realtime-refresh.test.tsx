// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import { botsNavPanel, botsSidebarComponent, renderBotsSidebar, renderSlot } from "./sidebar-host"
import { botsPanelNavigateCall } from "../lib/bots-panel";
import { bot, personalProjectId } from "./fixtures";
const app = await loadPluginApp(() => import("../app"));
afterEach(cleanup);
it("refreshes after reconnect and ignores an older response arriving last", async () => {
  const result = (name: string) => ({ bots: [{ ...bot, name }], hosts: [], sections: [], projects: [], threadBindings: [], warnings: [], personalProjectId });
  let calls = 0;
  let resolveOld!: (value: ReturnType<typeof result>) => void;
  const slot = renderBotsSidebar(app, "", {
    sidebarThreads: { projects: [], threads: [] }, realtimeConnectionState: "connected",
    rpc: { bots_list: () => ++calls === 1 ? result("Initial") : calls === 2 ? new Promise(resolve => { resolveOld = resolve; }) : result("Latest") },
  });
  await slot.findByText("Initial");
  await slot.behavior.setRealtimeConnectionState("reconnecting");
  await slot.behavior.setRealtimeConnectionState("connected");
  await waitFor(() => expect(calls).toBe(2));
  await slot.behavior.emitRealtime("project-bots-changed", {});
  await slot.findByText("Latest");
  await act(async () => resolveOld(result("Stale")));
  expect(slot.queryByText("Stale")).toBeNull();
  expect(slot.getByText("Latest")).toBeTruthy();
});
