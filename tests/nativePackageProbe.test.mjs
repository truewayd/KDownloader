import assert from "node:assert/strict";
import test from "node:test";
import { probeWindowVisibility } from "../truedown/desktop/tests/windows-native-probe.mjs";

const timeout = () => Object.assign(new Error("probe timed out"), { killed: true, code: null, signal: "SIGTERM" });

test("package visibility probe retries a terminated deadline once without changing its bounds", async () => {
  let attempts = 0, checks = 0;
  const reports = [];
  const windows = await probeWindowVisibility(async (program, args, options) => {
    assert.equal(program, "pwsh");
    assert.deepEqual(args, ["-VisibilityOnly"]);
    assert.deepEqual(options, { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
    if (++attempts === 1) throw timeout();
    return { stdout: '[{"visible":true}]' };
  }, ["-VisibilityOnly"], () => { checks++; }, message => reports.push(message));
  assert.equal(attempts, 2);
  assert.equal(checks, 3);
  assert.equal(reports.length, 1);
  assert.deepEqual(windows, [{ visible: true }], "the caller must still reject any visible window");
});

test("package visibility probe fails closed on repeat timeouts, invalid output and non-timeout failures", async () => {
  for (const failure of [timeout(), new Error("invalid native query"), Object.assign(new Error("large output"), { killed: true, code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", signal: "SIGTERM" })]) {
    let attempts = 0;
    await assert.rejects(probeWindowVisibility(async () => { attempts++; throw failure; }, [], () => {}), error => error === failure);
    assert.equal(attempts, failure.code === null ? 2 : 1);
  }
  let attempts = 0;
  await assert.rejects(probeWindowVisibility(async () => { attempts++; return { stdout: "not JSON" }; }, [], () => {}), SyntaxError);
  assert.equal(attempts, 1);
});

test("package visibility probe does not retry after the application exits", async () => {
  let attempts = 0;
  await assert.rejects(probeWindowVisibility(async () => { attempts++; throw timeout(); }, [], () => {
    if (attempts) throw new Error("application exited");
  }), /application exited/);
  assert.equal(attempts, 1);
});
