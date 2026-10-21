import { afterEach, describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { backend } from "./backend-fixture";

const hosts: Awaited<ReturnType<typeof backend>>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });

async function setup() {
  const host = await backend();
  hosts.push(host);
  return { host, run: host.harness.behavior.runCli.bind(host.harness.behavior) };
}

describe("fleet cli", () => {
  it("creates nodes and bots under addresses", async () => {
    const { run } = await setup();
    for (const argv of [
      ["node", "create", "billing", "--kind", "app", "--project", "project"],
      ["node", "create", "billing/ledger", "--kind", "schema", "--data-service-path", "api/ledger"],
      ["create", "--name", "lead", "--role", "Module Lead", "--machine", "Execution machine", "--soul", "Lead soul", "--node", "billing", "--project", "project", "--as", "owner"],
      ["create", "--name", "ui", "--role", "Engineer", "--machine", "Execution machine", "--soul", "UI soul", "--node", "billing", "--parent", "billing/lead"],
    ]) expect((await run(argv)).exitCode).toBe(0);
    const tree = JSON.parse((await run(["tree", "billing", "--json"])).stdout!);
    expect(tree.apps[0].app).toBe("billing");
    const list = JSON.parse((await run(["list", "--json"])).stdout!);
    const lead = list.bots.find((bot: { name: string }) => bot.name === "lead");
    expect(lead.parentBotId).toBeNull();
    expect(lead.address).toBe("billing/lead");
    const show = JSON.parse((await run(["show", "billing/ui", "--json"])).stdout!);
    expect(show.name).toBe("billing/ui");
    expect(show.parent?.name).toBe("billing/lead");
  });

  it("resolves shared bots by bare name and errors on ambiguous fleet names", async () => {
    const { host, run } = await setup();
    await run(["create", "--name", "architect", "--role", "Architect", "--machine", "Execution machine", "--soul", "Shared"]);
    await run(["node", "create", "billing", "--kind", "app"]);
    await run(["create", "--name", "lead", "--role", "Lead", "--machine", "Execution machine", "--soul", "A", "--node", "billing"]);
    await run(["node", "create", "payments", "--kind", "app"]);
    await run(["create", "--name", "lead", "--role", "Lead", "--machine", "Execution machine", "--soul", "B", "--node", "payments"]);
    const ambiguous = await run(["message", "lead", "hi"]);
    expect(ambiguous.exitCode).toBe(1);
    expect(ambiguous.stderr).toContain("billing/lead");
    const architect = host.store.list().find((bot) => bot.name === "architect")!;
    host.threads.set(architect.id, makeThreadResponse({ id: architect.id, projectId: "project" }));
    host.store.bind(architect.id, architect.id);
    host.store.save({ ...architect, mainThreadId: architect.id });
    host.harness.inspection.sdk.stub("threads.send", async () => ({ ok: true as const, delivery: "sent" as const }));
    expect((await run(["message", "architect", "hi"])).exitCode).toBe(0);
  });

  it("links and releases project ownership", async () => {
    const { run } = await setup();
    await run(["create", "--name", "owner", "--role", "Owner", "--machine", "Execution machine", "--soul", "x", "--project", "project", "--as", "owner"]);
    await run(["create", "--name", "rival", "--role", "Rival", "--machine", "Execution machine", "--soul", "y"]);
    expect((await run(["link", "rival", "project", "--as", "owner"])).exitCode).toBe(1);
    await run(["release", "owner", "project"]);
    expect((await run(["link", "rival", "project", "--as", "owner"])).exitCode).toBe(0);
  });
});
