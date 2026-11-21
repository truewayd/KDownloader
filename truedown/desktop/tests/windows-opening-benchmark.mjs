// Hidden WebView2 timing only: does not measure DWM presentation or shell renewal.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { chromium } from "playwright";

assert.equal(process.platform, "win32");
const [before, after, output] = process.argv.slice(2);
assert.ok(before && after && output, "Usage: before-directory after-directory result.json");
async function port() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const result = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return result;
}
async function until(check, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Benchmark readiness timed out");
}
const invoke = (page, command, args) => page.evaluate(({ command, args }) => window.__TAURI__.core.invoke(command, args), { command, args });
const results = [];
async function sample(variant, directory, round) {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "truedown-opening-timing-"));
  const apiPort = await port(), debugPort = await port();
  const launch = Date.now();
  const child = spawn(path.join(path.resolve(directory), "TrueDown.exe"), ["--background", "--data-dir", fixture], {
    windowsHide: true, stdio: "ignore", env: { ...process.env,
      TRUEDOWN_DESKTOP_TEST: "1", TRUEDOWN_ADDR: `127.0.0.1:${apiPort}`,
      TRUEDOWN_DESKTOP_TEST_DEBUG_PORT: String(debugPort), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "",
      TRUEDOWN_API_TOKEN: "", TRUEDOWN_REQUIRE_TOKEN: "", TRUEDOWN_TLS_CERT: "", TRUEDOWN_TLS_KEY: "",
    },
  });
  let browser, main, launchError;
  child.on("error", error => { launchError = error; });
  try {
    await until(async () => {
      if (launchError) throw launchError;
      assert.equal(child.exitCode, null);
      return fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(1000) }).then(r => r.ok, () => false);
    });
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    const context = browser.contexts()[0];
    main = context.pages()[0];
    await until(() => main.evaluate(() => Boolean(document.documentElement.dataset.material && window.__TAURI__?.core)).catch(() => false));
    const mainReady = await until(() => main.evaluate(() => {
      const end = performance.getEntriesByType("navigation")[0]?.domContentLoadedEventEnd;
      return end && performance.timeOrigin + end;
    }));
    results.push({ variant, round, kind: "main", phase: "startup", domReadyMs: mainReady - launch });
    await context.addInitScript(() => {
      const now = () => performance.timeOrigin + performance.now();
      const timing = window.__openingTiming = {};
      document.addEventListener("DOMContentLoaded", () => { timing.dom = now(); }, { once: true });
      const observer = new MutationObserver(() => {
        if (document.documentElement?.dataset.material && !timing.material) timing.material = now();
        const content = document.querySelector(".settings-content");
        if (content?.dataset.loading === "false" && content.dataset.category === "general" && !timing.editable) timing.editable = now();
      });
      observer.observe(document, { subtree: true, attributes: true, attributeFilter: ["data-material", "data-loading"] });
    });
    for (const kind of ["settings", "new-task"]) {
      const command = main.evaluate(async kind => {
        const start = performance.timeOrigin + performance.now();
        await window.__TAURI__.core.invoke("open_auxiliary", { kind });
        return { start, commandMs: performance.timeOrigin + performance.now() - start };
      }, kind);
      const page = await until(() => context.pages().find(page => page.url().includes(`window=${kind}`)));
      const timing = await until(() => page.evaluate(() => {
        const t = window.__openingTiming;
        return t?.dom && t?.material ? t : null;
      }).catch(() => false));
      const measured = await command;
      const editable = kind === "settings" ? await until(() => page.evaluate(() => window.__openingTiming?.editable)) : null;
      results.push({ variant, round, kind, phase: "first", commandMs: measured.commandMs,
        surfaceMs: Math.max(timing.dom, timing.material) - measured.start,
        ...(editable ? { editableMs: editable - measured.start } : {}) });
      await until(() => page.evaluate(kind => kind !== "new-task" || (typeof nativeTaskFormReady !== "undefined" && nativeTaskFormReady), kind));
      if (kind === "settings") {
        for (const category of ["engine", "files", "application", "about", "general"]) {
          await page.evaluate(category => {
            const content = document.querySelector(".settings-content");
            const start = performance.now();
            delete window.__openingTiming.categoryMs;
            const observer = new MutationObserver(() => {
              if (content.dataset.category === category && content.dataset.loading === "false") {
                observer.disconnect();
                window.__openingTiming.categoryMs = performance.now() - start;
              }
            });
            observer.observe(content, { attributes: true, attributeFilter: ["data-loading", "data-category"] });
            document.querySelector(`[data-settings-link="${category}"]`).click();
          }, category);
          const { elapsed } = await until(() => page.evaluate(() => {
            const value = window.__openingTiming.categoryMs;
            return Number.isFinite(value) && { elapsed: value };
          }));
          results.push({ variant, round, kind, phase: "category", category, elapsed });
        }
      }
      for (let attempt = 0; attempt < 10; attempt++) {
        await invoke(page, "close_auxiliary");
        const commandMs = await main.evaluate(async kind => {
          const start = performance.now();
          await window.__TAURI__.core.invoke("open_auxiliary", { kind });
          return performance.now() - start;
        }, kind);
        results.push({ variant, round, kind, phase: "retained", attempt, commandMs });
      }
      await invoke(page, "close_auxiliary");
    }
    console.log(`${variant} round ${round}: complete`);
  } finally {
    if (main && child.exitCode === null) await invoke(main, "core_request", { request: { method: "POST", path: "/system/exit" } }).catch(() => {});
    await until(() => child.exitCode !== null || child.signalCode !== null, 10000).catch(() => {
      try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch {}
    });
    await browser?.close().catch(() => {});
  }
}
for (let round = 0; round < 5; round++) {
  for (const variant of round % 2 ? ["after", "before"] : ["before", "after"]) {
    await sample(variant, variant === "before" ? before : after, round);
    await fs.writeFile(output, JSON.stringify({ scope: "Hidden WebView2; excludes compositor and native shell renewal", results }, null, 2));
  }
}
const groups = Map.groupBy(results, row => JSON.stringify([row.kind, row.phase, row.category, row.variant]));
for (const rows of groups.values()) {
  const { kind, phase, category, variant } = rows[0];
  const summary = { kind, phase, category, variant, n: rows.length };
  for (const [key, label] of Object.entries({ domReadyMs: "domReadyMedianMs", commandMs: "commandMedianMs", surfaceMs: "surfaceMedianMs", editableMs: "editableMedianMs", elapsed: "categoryMedianMs" })) {
    if (!(key in rows[0])) continue;
    const values = rows.map(row => row[key]).sort((a, b) => a - b);
    summary[label] = (values[(values.length - 1) >> 1] + values[values.length >> 1]) / 2;
  }
  console.log(JSON.stringify(summary));
}
