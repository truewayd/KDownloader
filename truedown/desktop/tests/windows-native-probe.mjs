// Cold PowerShell/Add-Type startup can exhaust a CI probe's deadline. Retry
// only that terminated attempt; visibility/format failures remain terminal.
export async function probeWindowVisibility(run, args, assertRunning, report = () => {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    assertRunning();
    try {
      const state = await run("pwsh", args, { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
      assertRunning();
      return JSON.parse(state.stdout);
    } catch (error) {
      const timedOut = error.killed === true && error.code === null && error.signal === "SIGTERM";
      if (!timedOut || attempt === 1) throw error;
      report("Window visibility probe timed out; retrying once with a fresh PowerShell process.");
    }
  }
}
