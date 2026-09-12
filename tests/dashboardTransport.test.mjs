import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../truedown/web/api.js", import.meta.url), "utf8");

for (const transport of ["native", "http"]) {
  test(`${transport} GET deadlines still apply with a caller cancellation signal`, async () => {
    const deadlines = [], calls = [];
    const timeout = new AbortController();
    const caller = new AbortController();
    const context = vm.createContext({
      Headers, Response, DOMException, apiToken: "",
      AbortSignal: {
        any: signals => AbortSignal.any(signals),
        timeout: ms => { deadlines.push(ms); return timeout.signal; },
      },
      window: { __TAURI__: { core: { invoke: (_command, args) => {
        calls.push(args);
        return new Promise(() => {});
      } } } },
      fetch: (_url, options) => {
        calls.push(options);
        return new Promise((_, reject) => {
          options.signal?.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
      },
    });
    vm.runInContext(source, context);
    const run = transport === "native" ? context.nativeFetch : context.fetchWithAPIToken;
    const pending = run("/tasks/detail?id=1", { method: "get", signal: caller.signal });
    assert.deepEqual(deadlines, [15000], "route cancellation must not replace the read deadline");
    timeout.abort(new DOMException("Timed out", "TimeoutError"));
    await assert.rejects(pending, { name: "TimeoutError" });
    assert.equal(calls.length, 1, "a timed out request must not be replayed");
    assert.equal(caller.signal.aborted, false);
  });
}
