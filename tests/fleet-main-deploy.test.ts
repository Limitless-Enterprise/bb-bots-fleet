import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { backend } from "./backend-fixture";

const hosts: Awaited<ReturnType<typeof backend>>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });

describe("fleet main and deploy", () => {
  it("dry-runs and applies deploy, then opens main", async () => {
    const host = await backend();
    hosts.push(host);
    const run = host.harness.behavior.runCli.bind(host.harness.behavior);
    const manifest = join(process.cwd(), "tests/fixtures/team-billing.json");
    expect((await run(["deploy", manifest, "--json"])).exitCode).toBe(0);
    const applied = await run(["deploy", manifest, "--apply", "--json"]);
    if (applied.exitCode !== 0) throw new Error(applied.stderr ?? applied.stdout);
    expect(host.store.list().some((bot) => bot.name === "lead")).toBe(true);
    const main = await run(["main", "billing/lead", "--project", "project", "--replace", "--json"]);
    expect(main.exitCode).toBe(0);
    expect(JSON.parse(main.stdout!).main).toBe(true);
  });
});
