/**
 * The window starts this process, and when the window is killed rather than closed (a crash, Task
 * Manager, an installer replacing it) it cannot stop it. Left alone the backend keeps port 4000, and
 * the model in memory, with nothing to serve; the next launch then talks to the old copy. So the window
 * hands over its pid (OSAVA_PARENT_PID) and the backend leaves when that process does.
 */

/** Does a process with this pid exist? Signal 0 only asks. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it is there and we may not signal it. Only ESRCH says it is gone.
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Calls `onGone` once, when `pid` no longer exists. Returns a function that stops watching. */
export function watchParent(
  pid: number,
  onGone: () => void,
  opt: { intervalMs?: number; alive?: (pid: number) => boolean } = {},
): () => void {
  const alive = opt.alive ?? pidAlive;
  const timer = setInterval(() => {
    if (alive(pid)) return;
    clearInterval(timer);
    onGone();
  }, opt.intervalMs ?? 2000);
  timer.unref();   // watching must never be what keeps a process alive
  return () => clearInterval(timer);
}
