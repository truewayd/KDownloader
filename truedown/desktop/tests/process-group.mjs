// Drivers run in their own Unix process group so failed automation cannot leave
// a descendant holding the driver's output pipes and the test runner open.
export async function stopProcessGroup(child, grace = 3000) {
  if (!child.pid) return;
  const signal = name => {
    try { process.kill(-child.pid, name); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  const alive = () => {
    try { process.kill(-child.pid, 0); return true; }
    catch (error) { if (error.code === "ESRCH") return false; throw error; }
  };
  let closed = (child.exitCode !== null || child.signalCode !== null) && child.stdout.destroyed && child.stderr.destroyed;
  let finished;
  const done = new Promise(resolve => { finished = () => { closed = true; resolve(true); }; });
  child.once("close", finished);
  const wait = async () => {
    if (closed) return true;
    let timer;
    try { return await Promise.race([done, new Promise(resolve => { timer = setTimeout(() => resolve(false), grace); })]); }
    finally { clearTimeout(timer); }
  };
  try {
    signal("SIGTERM");
    await wait();
    // A descendant may close its inherited pipes without leaving the group.
    // Parent exit alone must never skip termination of that descendant.
    if (!alive()) return;
    signal("SIGKILL");
    if (await wait()) return;
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
    throw new Error("Automation process group did not close after SIGKILL");
  } finally {
    child.removeListener("close", finished);
  }
}
