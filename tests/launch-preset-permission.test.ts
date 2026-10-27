import { describe, expect, it } from "vitest";
import { createBotStore } from "../lib/bot-store";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  LAUNCH_PRESET_FULL_PERMISSION_WARNING,
  launchPresetSchema,
  launchPresetStoredSchema,
  parseStoredLaunchPreset,
} from "../lib/launch-preset";
import { avatar } from "./backend-fixture";

describe("fleet launch preset permissions", () => {
  it("rejects full permission on write paths", () => {
    const preset = {
      execution: { providerId: "h", model: "m", reasoningLevel: "low", permissionMode: "full" as const },
      workspace: "checkout" as const,
      initialPrompt: "",
    };
    expect(() => launchPresetSchema.parse(preset)).toThrow();
  });

  it("accepts fleet permission modes on write paths", () => {
    expect(launchPresetSchema.parse({
      execution: { providerId: "h", model: "m", reasoningLevel: "low", permissionMode: "auto" },
      workspace: "checkout",
      initialPrompt: "",
    }).execution?.permissionMode).toBe("auto");
  });

  it("coerces stored full permission to null while loading", () => {
    const stored = {
      execution: { providerId: "h", model: "m", reasoningLevel: "low", permissionMode: "full" },
      workspace: "worktree",
      initialPrompt: "go",
    };
    expect(parseStoredLaunchPreset(stored)?.execution?.permissionMode).toBeNull();
    expect(launchPresetStoredSchema.parse(stored)?.execution?.permissionMode).toBeNull();
  });

  it("surfaces a warning when persisted bots still store full permission", async () => {
    const host = createFakePluginHost({ pluginId: "bots-fleet" });
    const store = createBotStore(host.bb);
    store.save({
      id: "bot_full", name: "Full preset", role: "R", hostId: "host-home", stateReady: true, legacyHomeProjectId: null,
      avatar, sectionId: null, linkedProjectIds: [], mainThreadId: null, hiddenUntilActivity: false, hiddenAt: null,
      order: 0, soul: "", agents: "", memory: "", settings: {}, stateHashes: { "SOUL.md": null, "AGENTS.md": null, "MEMORY.md": null, "settings.json": null },
      updatedAt: 1, legacyProjectId: null, launchPreset: {
        execution: { providerId: "h", model: "m", reasoningLevel: "low", permissionMode: "auto" },
        workspace: "checkout",
        initialPrompt: "",
      },
    });
    host.bb.storage.database().prepare("UPDATE bots SET data = json_set(data, '$.launchPreset.execution.permissionMode', 'full') WHERE id = ?").run("bot_full");
    expect(store.launchPresetStorageWarnings()).toEqual([LAUNCH_PRESET_FULL_PERMISSION_WARNING]);
    expect(store.require("bot_full").launchPreset?.execution?.permissionMode).toBeNull();
    await host.harness.lifecycle.dispose();
  });
});
