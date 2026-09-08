import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

assert.ok(process.argv[2], "Pass the built truedown-core executable");
const executable = path.resolve(process.argv[2]);
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "truedown-task-settings-"));
const fixture = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Length": 64 * 1024 * 1024, "Content-Type": "application/octet-stream" });
  const chunk = Buffer.alloc(16 * 1024, 42);
  const timer = setInterval(() => { if (!response.writableNeedDrain) response.write(chunk); }, 10);
  response.on("close", () => clearInterval(timer));
});
await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
const reservation = http.createServer();
await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
let child;
async function until(predicate) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Task settings acceptance timed out");
}
async function request(route, value) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: value === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: value === undefined ? undefined : JSON.stringify(value), signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  assert.ok(response.ok, `${route}: ${response.status} ${text}`);
  return text.startsWith("{") ? JSON.parse(text) : text;
}
async function launch() {
  child = spawn(executable, ["--data-dir", profile], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env, TRUEDOWN_ADDR: `127.0.0.1:${port}`, TRUEDOWN_API_TOKEN: "", TRUEDOWN_REQUIRE_TOKEN: "",
    TRUEDOWN_TLS_CERT: "", TRUEDOWN_TLS_KEY: "",
  } });
  let launchError;
  child.on("error", error => { launchError = error; });
  child.stdout.resume(); child.stderr.resume();
  await until(async () => {
    if (launchError) throw launchError;
    assert.equal(child.exitCode, null, "Core exited before readiness");
    assert.equal(child.signalCode, null, "Core was signaled before readiness");
    return request("/system/info").catch(() => false);
  });
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    await request("/system/exit", {});
    await until(() => child.exitCode !== null || child.signalCode !== null);
    assert.equal(child.exitCode, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}
try {
  await launch();
  await request("/start-headless-download", {
    downloadSource: { link: `http://127.0.0.1:${fixture.address().port}/source.PSD`, headers: { Cookie: "private-integration-cookie" } },
    name: "source.PSD", opts: { connections: 4, maxSpeedBps: 65536 },
  });
  const task = await until(async () => (await request("/tasks")).tasks.find(task => task.status === "downloading"));
  const route = `/tasks/detail?id=${task.id}`;
  let detail = await request(route);
  assert.equal(detail.category, "project");
  assert.equal(JSON.stringify(detail).includes("private-integration-cookie"), false);
  detail = await request(route, { revision: detail.settingsRevision, values: { ...detail.settings, maxSpeedBps: 131072 } });
  assert.equal(detail.settings.maxSpeedBps, 131072);
  await request(`/tasks/pause?id=${task.id}`, {});
  detail = await until(async () => { const value = await request(route); return value.status === "paused" && value; });
  detail = await request(route, { revision: detail.settingsRevision, values: { ...detail.settings, connections: 8, maxTries: 7 } });
  assert.equal(detail.settings.connections, 8);
  assert.equal(detail.settings.maxTries, 7);
  const groups = await request("/settings/file-groups");
  groups.groups.find(group => group.id === "project").extensions = [".blend"];
  groups.groups.push({ id: "design", name: "Design sources", extensions: [".psd"] });
  await request("/settings/file-groups", { revision: groups.revision, groups: groups.groups });
  assert.equal((await request("/tasks?category=design")).tasks[0].id, task.id);
  await stop();
  await launch();
  const restored = await request(route);
  assert.deepEqual(restored.settings, detail.settings);
  assert.equal(restored.category, "design");
  assert.equal(restored.status, "paused");
  console.log("live_speed=ok paused_connections=ok private_details=ok group_filter=ok restart_persistence=ok");
} finally {
  try { await stop(); }
  finally {
    fixture.closeAllConnections();
    await new Promise(resolve => fixture.close(resolve));
  }
}
