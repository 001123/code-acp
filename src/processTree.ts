import { execa } from "execa";

/** How long a stopped process gets to exit on SIGTERM before it is killed. */
const KILL_GRACE_MS = 3000;

/**
 * Stops a process started with `detached` on POSIX and whatever it started: it leads its own process group,
 * so wrappers such as `uvx`, `npx` or a shell don't leave their child running, and SIGKILL follows if it
 * ignores SIGTERM. Windows has no signals to wait on: `taskkill /T` ends the whole tree, cmd.exe shims included.
 */
export function stopProcess(child: { readonly pid?: number | undefined; kill(): boolean }, ended: () => boolean): void {
  if (ended() || child.pid === undefined) {
    return;
  }
  const pid = child.pid;
  if (process.platform === "win32") {
    void execa("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", reject: false }).then((result) => {
      if (result.failed) {
        child.kill();
      }
    });
    return;
  }
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-pid, name);
    } catch {
      // Already gone.
    }
  };
  signal("SIGTERM");
  setTimeout(() => {
    if (!ended()) {
      signal("SIGKILL");
    }
  }, KILL_GRACE_MS).unref();
}
