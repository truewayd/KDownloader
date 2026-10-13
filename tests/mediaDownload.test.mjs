import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { dashboardSource as source } from "./helpers/truedownSource.mjs";

function declarations(...names) {
  return names.map(name => {
    const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
    assert.ok(match, name); return match[0];
  }).join("\n");
}

test("media progress uses presentation duration and live recording never claims a percentage", () => {
  const context = vm.createContext({});
  vm.runInContext(declarations("taskProgressPercent", "taskProgressLabel", "renderTaskProgress"), context);
  const task = { status: "downloading", totalLength: 2, completedLength: 2, media: { duration: 60000, completedDuration: 15000, progress: .25, state: "downloading" } };
  assert.equal(context.taskProgressPercent(task), 25);
  let removed = false;
  const progress = { value: 10, hasAttribute: () => true, removeAttribute: key => { assert.equal(key, "value"); removed = true; } };
  context.renderTaskProgress(progress, task); assert.equal(progress.value, 25);
  task.media.live = true; task.media.state = "recording";
  context.renderTaskProgress(progress, task); assert.equal(removed, true);
  assert.equal(context.taskProgressLabel(task), "正在录制 · 15 秒");
  task.status = "done"; assert.equal(context.taskProgressPercent(task), 100);
  assert.equal(context.taskProgressLabel({ status: "queued", requiresMediaEngine: true }), "等待 NEXT 3");
  assert.equal(context.taskProgressLabel({ status: "paused", requiresMediaEngine: true }), "需要 NEXT 3 · 保持暂停");
});

test("an older capability read cannot enable media after the engine changed", async () => {
  const reads = [], options = [{ value: "" }, { value: "hls" }, { value: "dash" }];
  const elements = { "m-media": { options }, "media-capability-status": {} };
  const context = vm.createContext({ mediaCapabilityRequest: 0, mediaCapabilities: {}, document: { getElementById: id => elements[id] }, requestJSON: () => new Promise(resolve => reads.push(resolve)) });
  vm.runInContext(declarations("refreshMediaCapabilities"), context);
  const older = context.refreshMediaCapabilities(), newer = context.refreshMediaCapabilities();
  reads[1]({ media: false }); await newer;
  reads[0]({ media: true }); await older;
  assert.equal(options[1].disabled, true); assert.equal(options[2].disabled, true);
});
