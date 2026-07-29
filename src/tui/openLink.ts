import { spawn } from "node:child_process";

/**
 * Hand a URL (or file path) to the OS opener — `open`/`xdg-open`/`start`.
 * A module-level indirection rather than a direct spawn so tests can swap the
 * implementation and assert WHAT would open without launching anything.
 */

export type Opener = (target: string) => void;

let opener: Opener = (target) => {
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [target]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", target]]
        : ["xdg-open", [target]];
  // Detached + ignored stdio: the browser must not inherit the TUI's terminal,
  // and a missing opener binary must not crash the app (error is swallowed —
  // the action already narrated itself to the feed).
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
};

export function openExternal(target: string): void {
  opener(target);
}

export function setOpener(fn: Opener): void {
  opener = fn;
}
