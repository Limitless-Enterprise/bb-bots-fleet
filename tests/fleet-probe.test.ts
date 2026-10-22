import { afterEach, describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { avatar, backend } from "./backend-fixture";

const hosts: Awaited<ReturnType<typeof backend>>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });

async function setup() {
  const host = await backend();
  hosts.push(host);
  return { host, run: host.harness.behavior.runCli.bind(host.harness.behavior) };
}

describe("fleet probes (reviewer BLOCK)", () => {
  it("1 legacy duplicate shared names do not block unrelated saves", async () => {
    const { host, run } = await setup();
    expect((await run(["create", "--name", "Atlas", "--role", "A", "--machine", "Execution machine", "--soul", "a"])).exitCode).toBe(0);
    const dup = await run(["create", "--name", "Atlas", "--role", "B", "--machine", "Execution machine", "--soul", "b"]);
    expect(dup.exitCode).toBe(1);
    expect(dup.stderr).toMatch(/Duplicate shared bot name/i);
    host.bb.storage.database().prepare("INSERT OR REPLACE INTO bots(id,data) VALUES (?,?)").run("bot_atlas2", JSON.stringify({
      id: "bot_atlas2", name: "Atlas", role: "Legacy B", hostId: "host-home", stateReady: true, legacyHomeProjectId: null,
      avatar, sectionId: null, linkedProjectIds: [], mainThreadId: null, hiddenUntilActivity: false, hiddenAt: null, order: 1,
      soul: "b", agents: "", memory: "", settings: {}, stateHashes: { "SOUL.md": null, "AGENTS.md": null, "MEMORY.md": null, "settings.json": null },
      updatedAt: 1, legacyProjectId: null, nodeId: null, parentBotId: null,
    }));
    host.store.mutate("bot_atlas2", (bot) => ({ ...bot, role: "Updated legacy" }));
    expect(host.store.require("bot_atlas2").role).toBe("Updated legacy");
  });

  it("2 thread callers cannot mutate registry except fleet steward", async () => {
    const { host, run } = await setup();
    await run(["create", "--name", "fleet", "--role", "Steward", "--machine", "Execution machine", "--soul", "steward"]);
    await run(["create", "--name", "victim", "--role", "V", "--machine", "Execution machine", "--soul", "safe"]);
    const victim = host.store.list().find((bot) => bot.name === "victim")!;
    const fleetBot = host.store.list().find((bot) => bot.name === "fleet")!;
    await run(["create", "--name", "worker", "--role", "W", "--machine", "Execution machine", "--soul", "w"]);
    const worker = host.store.list().find((bot) => bot.name === "worker")!;
    host.threads.set("attacker", makeThreadResponse({ id: "attacker", projectId: "project" }));
    host.store.bind("attacker", worker.id);
    const pwn = await run(["update", victim.id, "--soul", "pwned"], { threadId: "attacker" });
    expect(pwn.exitCode).toBe(1);
    host.threads.set("steward", makeThreadResponse({ id: "steward", projectId: "project" }));
    host.store.bind("steward", fleetBot.id);
    expect((await run(["update", victim.id, "--soul", "steward-updated"], { threadId: "steward" })).exitCode).toBe(0);
    expect(host.store.require(victim.id).soul).toBe("steward-updated");
  });

  it("3 enforces tree invariants (cross-app parent, folded schema, app vs shared name)", async () => {
    const { host, run } = await setup();
    await run(["create", "--name", "architect", "--role", "Shared", "--machine", "Execution machine", "--soul", "s"]);
    await run(["node", "create", "billing", "--kind", "app", "--project", "project"]);
    await run(["node", "create", "crm", "--kind", "app"]);
    await run(["create", "--name", "lead", "--role", "Lead", "--machine", "Execution machine", "--soul", "l", "--node", "billing"]);
    await run(["create", "--name", "lead", "--role", "CRM lead", "--machine", "Execution machine", "--soul", "c", "--node", "crm"]);
    const cross = await run(["create", "--name", "ui", "--role", "UI", "--machine", "Execution machine", "--soul", "u", "--node", "billing", "--parent", "crm/lead"]);
    expect(cross.exitCode).toBe(1);
    expect(cross.stderr).toMatch(/same app/i);
    await run(["create", "--name", "api", "--role", "API", "--machine", "Execution machine", "--soul", "api", "--node", "billing", "--parent", "billing/lead"]);
    await run(["node", "create", "billing/ledger", "--kind", "schema", "--folded-into", "billing/api"]);
    const onFolded = await run(["create", "--name", "data", "--role", "Data", "--machine", "Execution machine", "--soul", "d", "--node", "billing/ledger"]);
    expect(onFolded.exitCode).toBe(1);
    expect(onFolded.stderr).toMatch(/folded/i);
    const appCollision = await run(["node", "create", "architect", "--kind", "app"]);
    expect(appCollision.exitCode).toBe(1);
    expect(appCollision.stderr).toMatch(/collides/i);
  });

  it("4 launch preset flags on create and update", async () => {
    const { host, run } = await setup();
    await run(["create", "--name", "bot", "--role", "R", "--machine", "Execution machine", "--soul", "s",
      "--provider", "test-harness", "--model", "m1", "--reasoning", "low", "--permission", "accept-edits", "--workspace", "checkout"]);
    const created = host.store.list().find((bot) => bot.name === "bot")!;
    expect(created.launchPreset?.execution?.permissionMode).toBe("accept-edits");
    expect((await run(["update", "bot", "--permission", "full"])).exitCode).toBe(1);
    await run(["update", "bot", "--reasoning", "high"]);
    expect(host.store.require(created.id).launchPreset?.execution?.reasoningLevel).toBe("high");
  });

  it("5 rejects slash in new names and resolves legacy slash names", async () => {
    const { host, run } = await setup();
    host.bb.storage.database().prepare("INSERT OR REPLACE INTO bots(id,data) VALUES (?,?)").run("bot_legacyslash", JSON.stringify({
      id: "bot_legacyslash", name: "billing/lead", role: "Lead", hostId: "host-home", stateReady: true, legacyHomeProjectId: null,
      avatar, sectionId: null, linkedProjectIds: [], mainThreadId: null, hiddenUntilActivity: false, hiddenAt: null, order: 0,
      soul: "legacy", agents: "", memory: "", settings: {}, stateHashes: { "SOUL.md": null, "AGENTS.md": null, "MEMORY.md": null, "settings.json": null },
      updatedAt: 1, legacyProjectId: null, nodeId: null, parentBotId: null,
    }));
    expect((await run(["show", "billing/lead", "--json"])).exitCode).toBe(0);
    host.store.mutate("bot_legacyslash", (bot) => ({ ...bot, role: "Still legacy" }));
    expect((await run(["create", "--name", "new/bot", "--role", "X", "--machine", "Execution machine", "--soul", "x"])).exitCode).toBe(1);
  });

  it("round2 duplicate new shared fleet name is rejected", async () => {
    const { run } = await setup();
    expect((await run(["create", "--name", "fleet", "--role", "Steward", "--machine", "Execution machine", "--soul", "a"])).exitCode).toBe(0);
    const dup = await run(["create", "--name", "fleet", "--role", "Fake", "--machine", "Execution machine", "--soul", "b"]);
    expect(dup.exitCode).toBe(1);
    expect(dup.stderr).toMatch(/Duplicate shared bot name/i);
  });

  it("round2 rejects a second app root without parent", async () => {
    const { run } = await setup();
    await run(["node", "create", "billing", "--kind", "app", "--project", "project"]);
    await run(["create", "--name", "lead", "--role", "Lead", "--machine", "Execution machine", "--soul", "l", "--node", "billing"]);
    const rogue = await run(["create", "--name", "rogue", "--role", "Rogue", "--machine", "Execution machine", "--soul", "r", "--node", "billing"]);
    expect(rogue.exitCode).toBe(1);
    expect(rogue.stderr).toMatch(/lead/i);
  });

  it("round2 schema nodes accept only data bots", async () => {
    const { run } = await setup();
    await run(["node", "create", "billing", "--kind", "app"]);
    await run(["create", "--name", "lead", "--role", "Lead", "--machine", "Execution machine", "--soul", "l", "--node", "billing"]);
    await run(["node", "create", "billing/ledger", "--kind", "schema"]);
    const ui = await run(["create", "--name", "ui", "--role", "UI", "--machine", "Execution machine", "--soul", "u", "--node", "billing/ledger", "--parent", "billing/lead"]);
    expect(ui.exitCode).toBe(1);
    expect(ui.stderr).toMatch(/data bots/i);
    expect((await run(["create", "--name", "data", "--role", "Data", "--machine", "Execution machine", "--soul", "d", "--node", "billing/ledger", "--parent", "billing/lead"])).exitCode).toBe(0);
  });

  it("round3 app lead must be named lead and cannot be renamed", async () => {
    const { run } = await setup();
    await run(["node", "create", "billing", "--kind", "app"]);
    const badLead = await run(["create", "--name", "boss", "--role", "Lead", "--machine", "Execution machine", "--soul", "l", "--node", "billing"]);
    expect(badLead.exitCode).toBe(1);
    expect(badLead.stderr).toMatch(/named lead/i);
    await run(["create", "--name", "lead", "--role", "Lead", "--machine", "Execution machine", "--soul", "l", "--node", "billing"]);
    const secondRoot = await run(["create", "--name", "ui", "--role", "UI", "--machine", "Execution machine", "--soul", "u", "--node", "billing"]);
    expect(secondRoot.exitCode).toBe(1);
    const rename = await run(["update", "billing/lead", "--name", "boss"]);
    expect(rename.exitCode).toBe(1);
    expect(rename.stderr).toMatch(/cannot be renamed/i);
  });

  it("round3 --no-parent is a boolean flag and cannot unpinned members", async () => {
    const { run } = await setup();
    await run(["node", "create", "billing", "--kind", "app"]);
    await run(["create", "--name", "lead", "--role", "Lead", "--machine", "Execution machine", "--soul", "l", "--node", "billing"]);
    await run(["create", "--name", "ui", "--role", "UI", "--machine", "Execution machine", "--soul", "u", "--node", "billing", "--parent", "billing/lead"]);
    expect((await run(["update", "billing/ui", "--no-parent"])).exitCode).toBe(1);
    expect((await run(["update", "billing/ui", "--no-parent", "--json"])).stderr).toMatch(/remove parent/i);
  });

  it("6 tree marks engaged shared bots", async () => {
    const { run } = await setup();
    await run(["node", "create", "billing", "--kind", "app", "--project", "project"]);
    await run(["create", "--name", "architect", "--role", "Shared", "--machine", "Execution machine", "--soul", "s", "--project", "project", "--as", "member"]);
    const tree = await run(["tree", "billing"]);
    expect(tree.stdout).toContain("architect (engaged)");
  });
});
