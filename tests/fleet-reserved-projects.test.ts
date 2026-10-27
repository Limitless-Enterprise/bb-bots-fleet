import { afterEach, describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { join } from "node:path";
import { backend } from "./backend-fixture";

const hosts: Awaited<ReturnType<typeof backend>>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });

describe("reserved project IDs", () => {
  it("blocks deploy, link --as owner, and conversation_assign on reserved projects", async () => {
    const host = await backend();
    hosts.push(host);
    await host.harness.behavior.setSettings({ reservedProjectIds: "project" });
    const run = host.harness.behavior.runCli.bind(host.harness.behavior);
    await run(["create", "--name", "worker", "--role", "W", "--machine", "Execution machine", "--soul", "w"]);
    const manifest = join(process.cwd(), "tests/fixtures/team-billing.json");
    const deploy = await run(["deploy", manifest, "--apply", "--json"]);
    expect(deploy.exitCode).toBe(1);
    expect(deploy.stderr).toMatch(/reserved project/i);
    const link = await run(["link", "worker", "project", "--as", "owner"]);
    expect(link.exitCode).toBe(1);
    host.threads.set("chat", makeThreadResponse({ id: "chat", projectId: "project" }));
    const worker = host.store.list().find((bot) => bot.name === "worker")!;
    await expect(host.harness.behavior.callRpc("conversation_assign", { botId: worker.id, threadId: "chat" })).rejects.toThrow(/reserved project/i);
    await run(["node", "create", "billing", "--kind", "app", "--project", "project"]);
    await run(["create", "--name", "lead", "--role", "Lead", "--machine", "Execution machine", "--soul", "l", "--node", "billing"]);
    const main = await run(["main", "billing/lead", "--project", "project", "--replace"]);
    expect(main.exitCode).toBe(1);
    expect(main.stderr).toMatch(/reserved project/i);
  });
});
