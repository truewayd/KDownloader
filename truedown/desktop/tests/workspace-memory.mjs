import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";

export async function readRendererHeap(cdp) {
  const chunks = [];
  const append = ({ chunk }) => chunks.push(chunk);
  cdp.on("HeapProfiler.addHeapSnapshotChunk", append);
  try {
    await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  } finally {
    cdp.off("HeapProfiler.addHeapSnapshotChunk", append);
  }
  const snapshot = JSON.parse(chunks.join(""));
  const { node_fields: fields, node_types: types } = snapshot.snapshot.meta;
  const type = fields.indexOf("type"), native = types[type].indexOf("native");
  const name = fields.indexOf("name"), detached = fields.indexOf("detachedness");
  assert.ok(native >= 0 && detached >= 0 && name >= 0, "snapshot must describe DOM node retention");
  let detachedNativeNodes = 0, textNodes = 0, undoSteps = 0;
  const detachedTypes = new Map();
  for (let i = 0; i < snapshot.nodes.length; i += fields.length) {
    if (snapshot.nodes[i + type] !== native) continue;
    const description = snapshot.strings[snapshot.nodes[i + name]];
    if (description === "Text") textNodes++;
    if (description === "blink::UndoStep") undoSteps++;
    if (snapshot.nodes[i + detached] === 2) {
      detachedNativeNodes++;
      const kind = description.match(/^<[\w-]+/)?.[0] || description.split(" / ")[0];
      detachedTypes.set(kind, (detachedTypes.get(kind) || 0) + 1);
    }
  }
  return { detachedNativeNodes, detachedTypes: Object.fromEntries(detachedTypes), textNodes, undoSteps };
}

export async function checkWorkspaceMemory(page, output) {
  const cdp = await page.context().newCDPSession(page);
  const samples = [];
  const top = page.locator("#tasks-wrap");
  const scrollTo = async index => {
    await top.evaluate((node, index) => { node.scrollTop = index * 64; }, index);
    await page.waitForFunction(index => currentTasks[0]?.id <= index + 1 && currentTasks.at(-1)?.id >= index + 1 && !loadTasksPromise, index);
  };
  try {
    await cdp.send("HeapProfiler.enable");
    for (let round = 0; round < 4; round++) {
      await page.evaluate(() => { window.memoryProbes = []; });
      await page.locator("[data-select-page]").check();
      await page.waitForFunction(() => selectedTaskIDs.size === 2400);
      await page.locator("#batch-clear-btn").click();
      for (const index of [350, 950, 1650, 0]) {
        await page.evaluate(() => {
          memoryProbes.push(new WeakRef(document.querySelector(".task-rows tr")));
        });
        await scrollTo(index);
        await page.locator("#task-filter").click();
        await page.getByRole("listbox").waitFor();
        await page.evaluate(() => memoryProbes.push(new WeakRef(document.querySelector(".kd-select-list"))));
        await page.keyboard.press("Escape");
        const from = await page.locator('[data-sort-field="file"]').boundingBox();
        const to = await page.locator('[data-sort-field="status"]').boundingBox();
        await page.mouse.move(from.x + 12, from.y + from.height / 2);
        await page.mouse.down();
        await page.mouse.move(to.x + to.width - 4, to.y + to.height / 2);
        await page.locator(".pointer-drag-hint").waitFor();
        await page.evaluate(() => memoryProbes.push(new WeakRef(document.querySelector(".pointer-drag-hint"))));
        await page.keyboard.press("Escape");
        await page.mouse.up();
      }
      await page.mouse.move(1, 1);
      await page.evaluate(() => document.activeElement?.blur());
      await cdp.send("HeapProfiler.collectGarbage");
      const counters = await cdp.send("Memory.getDOMCounters");
      const heap = await cdp.send("Runtime.getHeapUsage");
      const profile = await page.evaluate(() => ({
        tracked: memoryProbes.length,
        retained: memoryProbes.filter(probe => probe.deref()).map(probe => probe.deref().className || probe.deref().nodeName),
        selected: selectedTaskIDs.size, remembered: taskLinkByID.size, mounted: currentTasks.length,
        cachedPages: taskPages.cache.size,
      }));
      samples.push({ round: round + 1, ...counters, jsHeapBytes: heap.usedSize, ...profile });
      assert.deepEqual(profile.retained, [], "retired rows, pickers and drag feedback must be collectable");
      assert.equal(profile.remembered, profile.mounted);
      assert.equal(profile.selected, 0);
    }
    // Summarize the synthetic renderer snapshot without storing the large string table.
    const { detachedNativeNodes } = await readRendererHeap(cdp);
    await writeFile(path.join(output, "memory.json"), JSON.stringify({ samples, detachedNativeNodes }, null, 2));
    console.log("Renderer GC samples", JSON.stringify(samples));
  } finally {
    await page.evaluate(() => { delete window.memoryProbes; });
    await cdp.detach();
  }
}
