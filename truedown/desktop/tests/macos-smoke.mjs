import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { stopProcessGroup } from "./process-group.mjs";

if (process.platform !== "darwin") throw new Error("macOS native acceptance requires macOS");
const application = path.resolve(process.argv[2] || "target/debug/TrueDown");
assert.ok((await fs.lstat(application)).isFile(), "Build the debug native desktop first");
const profile = await fs.realpath(await fs.mkdtemp(path.join(process.env.RUNNER_TEMP || os.tmpdir(), "truedown-macos-")));
const server = net.createServer();
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const endpoint = `http://127.0.0.1:${port}`;
const child = spawn(application, ["--background", "--data-dir", profile], {
  detached: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, TRUEDOWN_MACOS_ACCEPTANCE: "1", TRUEDOWN_DESKTOP_TEST: "",
    TRUEDOWN_ADDR: `127.0.0.1:${port}`, TRUEDOWN_API_TOKEN: "", TRUEDOWN_REQUIRE_TOKEN: "",
    TRUEDOWN_TLS_CERT: "", TRUEDOWN_TLS_KEY: "", TRUEDOWN_UPDATE_HEALTH_FILE: "",
    TRUEDOWN_UPDATE_HEALTH_TOKEN: "", TRUEDOWN_UPDATE_EXPECTED_BUILD: "" },
});
let diagnostic = "", launchError, phase = "launch";
child.on("error", error => { launchError = error; });
for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { diagnostic = (diagnostic + data.toString()).slice(-16384); });
const abort = new AbortController();
const interrupted = () => abort.abort(new Error("macOS acceptance interrupted"));
process.on("SIGINT", interrupted);
process.on("SIGTERM", interrupted);
const exited = () => child.exitCode !== null || child.signalCode !== null;
function running() {
  if (launchError) throw launchError;
  if (exited()) throw new Error(`Desktop exited early (${child.exitCode ?? child.signalCode})`);
}
async function until(check, timeout, cancellable = true) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (cancellable) abort.signal.throwIfAborted();
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`${phase} timed out`);
}
const request = (route, options = {}) => fetch(endpoint + route, { ...options, signal: AbortSignal.timeout(5000) });
async function requestExit() {
  // A recycled port must never let failure cleanup stop another profile.
  const storage = await request("/system/storage");
  assert.equal(storage.status, 200);
  assert.equal(await fs.realpath((await storage.json()).dataDirectory), profile);
  return request("/system/exit", { method: "POST" });
}
try {
  phase = "native launch, close-to-hide and retained drafts";
  await until(() => {
    running();
    if (diagnostic.includes("macos_acceptance=failed")) throw new Error("Native acceptance reported failure");
    return diagnostic.split(/\r?\n/).includes("macos_acceptance=ok launch=ok close_to_hide=ok settings_draft=ok task_form_drafts=ok");
  }, 150000);
  // All four windows are hidden at this point; the owned core must still serve.
  phase = "core retained while windows are hidden";
  const response = await request("/system/info");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).product, "TrueDown");
  running();
  phase = "graceful native/core shutdown";
  const exit = await requestExit();
  assert.equal(exit.status, 202);
  await until(exited, 15000);
  assert.equal(child.exitCode, 0, "Desktop must exit cleanly after the owned core stops");
  await until(() => request("/system/info").then(() => false, () => true), 10000);
  console.log("macos_native_windows=ok retained_drafts=ok close_to_hide=ok graceful_shutdown=ok");
} catch (error) {
  error.message = `${phase}: ${error.message}\n${diagnostic}`;
  throw error;
} finally {
  try {
    // Attempt graceful shutdown even after a failed assertion, then kill only
    // this detached process group, including engines retaining inherited pipes.
    if (child.pid && !exited()) {
      await requestExit().catch(() => {});
      await until(exited, 5000, false).catch(() => {});
    }
    await stopProcessGroup(child);
  } finally {
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
    await fs.writeFile(path.join(profile, "acceptance.log"), `phase=${phase}\n${diagnostic}`);
    console.log(`profile=${profile}`);
  }
}
