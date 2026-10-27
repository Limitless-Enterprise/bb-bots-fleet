import { afterEach, describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backend } from "./backend-fixture";

const hosts: Awaited<ReturnType<typeof backend>>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });

describe("deploy reviewer coverage", () => {
  it("refuses deploy from a BB thread except fleet steward", async () => {
    const host = await backend();
    hosts.push(host);
    const run = host.harness.behavior.runCli.bind(host.harness.behavior);
    await run(["create", "--name", "fleet", "--role", "Steward", "--machine", "Execution machine", "--soul", "steward"]);
    const manifest = join(process.cwd(), "tests/fixtures/team-billing.json");
    const blocked = await run(["deploy", manifest], { threadId: "t1" });
    expect(blocked.exitCode).toBe(1);
    expect(blocked.stderr).toMatch(/operator-only/i);
    host.threads.set("steward", makeThreadResponse({ id: "steward", projectId: "project" }));
    const fleetBot = host.store.list().find((bot) => bot.name === "fleet")!;
    host.store.bind("steward", fleetBot.id);
    expect((await run(["deploy", manifest, "--json"], { threadId: "steward" })).exitCode).toBe(0);
  });

  it("re-apply deploy is idempotent and creates FLEET/SHARED/app sections", async () => {
    const host = await backend();
    hosts.push(host);
    const run = host.harness.behavior.runCli.bind(host.harness.behavior);
    const manifest = join(process.cwd(), "tests/fixtures/team-billing.json");
    expect((await run(["deploy", manifest, "--apply"])).exitCode).toBe(0);
    expect((await run(["deploy", manifest, "--apply"])).exitCode).toBe(0);
    const names = host.store.sections().map((section) => section.name);
    expect(names).toContain("FLEET");
    expect(names).toContain("SHARED");
    expect(names).toContain("billing");
  });

  it("dry-run reports blocked section move without changing operator placement", async () => {
    const host = await backend();
    hosts.push(host);
    const run = host.harness.behavior.runCli.bind(host.harness.behavior);
    const manifest = join(process.cwd(), "tests/fixtures/team-billing.json");
    await run(["deploy", manifest, "--apply"]);
    await host.harness.behavior.callRpc("section_create", { name: "Custom" });
    const customId = host.store.sections().find((section) => section.name === "Custom")?.id;
    await run(["create", "--name", "architect", "--role", "A", "--machine", "Execution machine", "--soul", "a", "--section", "Custom"]);
    const fixtureDir = join(process.cwd(), "tests/fixtures");
    const base = JSON.parse(readFileSync(join(fixtureDir, "team-billing.json"), "utf8")) as Record<string, unknown>;
    base.specialists = ["architect"];
    const manifestPath = join(fixtureDir, ".team-billing-specialists.json");
    writeFileSync(manifestPath, JSON.stringify(base));
    const preview = await run(["deploy", manifestPath, "--json"]);
    unlinkSync(manifestPath);
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).toMatch(/would-move-to-SHARED-blocked/);
    expect(host.store.list().find((bot) => bot.name === "architect")?.sectionId).toBe(customId);
  });

  it("does not steal project ownership from another bot on re-deploy", async () => {
    const host = await backend();
    hosts.push(host);
    const run = host.harness.behavior.runCli.bind(host.harness.behavior);
    await run(["create", "--name", "keeper", "--role", "K", "--machine", "Execution machine", "--soul", "k", "--project", "project", "--as", "owner"]);
    const keeper = host.store.list().find((bot) => bot.name === "keeper")!;
    const manifest = join(process.cwd(), "tests/fixtures/team-billing.json");
    const applied = await run(["deploy", manifest, "--apply", "--json"]);
    expect(applied.exitCode).toBe(0);
    expect(applied.stdout).toMatch(/skipped-other-owner/);
    expect(host.store.projectOwner("project")?.botId).toBe(keeper.id);
  });

  it("deploy creates app lead and schema data bots (W1b shape)", async () => {
    const host = await backend();
    hosts.push(host);
    const run = host.harness.behavior.runCli.bind(host.harness.behavior);
    const manifest = join(process.cwd(), "tests/fixtures/team-billing.json");
    await run(["deploy", manifest, "--apply"]);
    expect(host.store.list().some((bot) => bot.name === "lead" && bot.nodeId)).toBe(true);
    expect(host.store.list().some((bot) => bot.name === "ui" && bot.parentBotId)).toBe(true);
    const tree = await run(["tree", "billing", "--json"]);
    expect(tree.exitCode).toBe(0);
    expect(tree.stdout).toMatch(/billing\/lead/);
  });

  it("opens main and supports --replace", async () => {
    const host = await backend();
    hosts.push(host);
    const run = host.harness.behavior.runCli.bind(host.harness.behavior);
    const manifest = join(process.cwd(), "tests/fixtures/team-billing.json");
    await run(["deploy", manifest, "--apply"]);
    const first = await run(["main", "billing/lead", "--project", "project", "--replace", "--json"]);
    expect(first.exitCode).toBe(0);
    const lead = host.store.list().find((bot) => bot.name === "lead");
    expect(lead?.mainThreadId).toBeTruthy();
    const second = await run(["main", "billing/lead", "--project", "project", "--replace", "--json"]);
    expect(second.exitCode).toBe(0);
  });
});
