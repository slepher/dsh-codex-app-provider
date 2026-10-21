import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CodexSessionBackend } from "../lib/backend.js";
import { AppServer } from "../lib/rpc.js";
import { CodexProviderAdapter } from "../lib/provider.js";

for (const fault of ["timeout", "exit"]) test(`real RPC ${fault} terminates provider and never redispatches`, { timeout: 5000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-app-rpc-"));
  let starts = 0;
  const backend = new CodexSessionBackend(dir, () => {
    const rpc = new AppServer({ command: process.execPath, args: [fileURLToPath(new URL("./fixtures/uncertain-server.mjs", import.meta.url)), fault], timeoutMs: 300 });
    const request = rpc.request.bind(rpc);
    rpc.request = (method, params) => { if (method === "turn/start") starts++; return request(method, params); };
    return rpc;
  });
  const adapter = new CodexProviderAdapter({ currentCwd: () => dir, backend, providerCwd: dir, sessions: { get: () => ({ header: { cwd: dir } }) }, agents: { get() {} }, logger: { warn() {} } });
  t.after(async () => { adapter.close(); await backend.close(); rmSync(dir, { recursive: true, force: true }); });
  const options = { provider: "codex-app", model: "model", sessionId: "s", messages: [{ id: "u", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "once" }] }] };
  const run = async () => { for await (const _ of adapter.stream(options)) {} };
  await assert.rejects(run(), /timed out|unknown/i);
  await assert.rejects(run(), /unknown/i);
  assert.equal(starts, 1);
  assert.equal((await backend.readSession("dsh-codex-provider", "codex:s")).state, "unknown");
});
