import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { backend } from "./backend-fixture";

const hosts: Awaited<ReturnType<typeof backend>>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });

async function setup() {
  const host = await backend();
  hosts.push(host);
  const a = await host.create("Atlas");
  const b = await host.create("Beryl");
  host.threads.set(a.id, makeThreadResponse({ id: a.id, projectId: "project" }));
  host.threads.set(b.id, makeThreadResponse({ id: b.id, projectId: "project" }));
  host.store.bind(a.id, a.id);
  host.store.bind(b.id, b.id);
  const ctx = (threadId: string) => ({ threadId, projectId: "project" });
  const write = (threadId: string, body: string) => host.harness.behavior.callAgentTool("bot_memory", {
    action: "write", title: "Note", kind: "fact", importance: 50, body,
  }, ctx(threadId));
  return { host, a, b, ctx, write, run: host.harness.behavior.runCli.bind(host.harness.behavior) };
}

describe("private bot memory", () => {
  it("isolates memory between bots and supports inherited child conversations", async () => {
    const { host, a, b, ctx, write } = await setup();
    await write(a.id, "Atlas-only secret");
    const listed = JSON.parse(String(await host.harness.behavior.callAgentTool("bot_memory", { action: "list" }, ctx(a.id))));
    expect(listed.entries).toHaveLength(1);
    expect(listed.entries[0].hook).toContain("Atlas-only");
    const child = makeThreadResponse({ id: "child-a", projectId: "project", parentThreadId: a.id });
    host.threads.set(child.id, child);
    const inherited = JSON.parse(String(await host.harness.behavior.callAgentTool("bot_memory", { action: "list" }, ctx(child.id))));
    expect(inherited.entries).toHaveLength(1);
    const blocked = JSON.parse(String(await host.harness.behavior.callAgentTool("bot_memory", { action: "list" }, ctx(b.id))));
    expect(blocked.entries).toHaveLength(0);
  });

  it("rejects bot_memory when the conversation is not assigned to a bot", async () => {
    const { host } = await setup();
    host.threads.set("free", makeThreadResponse({ id: "free", projectId: "project" }));
    await expect(host.harness.behavior.callAgentTool("bot_memory", { action: "list" }, { threadId: "free", projectId: "project" })).rejects.toThrow(/not assigned to a bot/i);
  });

  it("refuses operator memory CLI from a thread and allows terminal use", async () => {
    const { a, write, run } = await setup();
    await write(a.id, "Operator export body");
    const fromThread = await run(["memory", a.id, "list"], { threadId: a.id });
    expect(fromThread.exitCode).toBe(1);
    expect(fromThread.stderr).toMatch(/operator-only/i);
    delete process.env.BB_THREAD_ID;
    const listed = await run(["memory", a.id, "list", "--json"]);
    expect(listed.exitCode).toBe(0);
    const data = JSON.parse(listed.stdout!);
    expect(data.entries).toHaveLength(1);
    const show = await run(["show", a.id, "--json"]);
    expect(JSON.parse(show.stdout!).memory.entries).toBe(1);
    expect(show.stdout).not.toContain("Operator export body");
  });

  it("requires expectedSha256 when updating an existing entry", async () => {
    const { a, ctx, write, host } = await setup();
    const created = JSON.parse(String(await write(a.id, "Version one")));
    await expect(host.harness.behavior.callAgentTool("bot_memory", {
      action: "write", id: created.id, title: "Note", kind: "fact", importance: 50, body: "Stale overwrite",
    }, ctx(a.id))).rejects.toThrow(/expectedSha256/i);
  });

  it("records history on update and includes history in export", async () => {
    const { host, a, ctx, write, run } = await setup();
    const created = JSON.parse(String(await write(a.id, "Version one")));
    const updated = JSON.parse(String(await host.harness.behavior.callAgentTool("bot_memory", {
      action: "write", id: created.id, title: "Note", kind: "fact", importance: 50, body: "Version two", expectedSha256: created.sha256,
    }, ctx(a.id))));
    expect(updated.body).toBe("Version two");
    delete process.env.BB_THREAD_ID;
    const read = await run(["memory", a.id, "read", created.id, "--json"]);
    const payload = JSON.parse(read.stdout!);
    expect(payload.history.length).toBeGreaterThanOrEqual(1);
    const dir = mkdtempSync(join(tmpdir(), "bot-memory-export-"));
    delete process.env.BB_THREAD_ID;
    const exported = await run(["memory", a.id, "export", "--to", dir]);
    expect(exported.exitCode).toBe(0);
    const history = JSON.parse(readFileSync(join(dir, "history", `${created.id}.json`), "utf8"));
    expect(history.some((row: { body: string }) => row.body === "Version one")).toBe(true);
  });
});
