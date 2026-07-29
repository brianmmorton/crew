import { proxy } from "valtio";

/**
 * App-level lifecycle state: what phase the TUI is in and how the boot is
 * going. Nothing else lives here — agent/run/feed state each have their own
 * isolated store so a boot-step update can never re-render the dashboard and
 * a log line can never re-render the splash.
 */

export type Phase = "loading" | "ready" | "error";

export type StepStatus = "active" | "done" | "failed";

export interface BootStep {
  label: string;
  status: StepStatus;
}

export const appStore = proxy({
  phase: "loading" as Phase,
  /** Project name from config, for the header — set once at boot. */
  project: "",
  /** Boot checklist shown on the splash, in start order. */
  steps: [] as BootStep[],
  /** Fatal boot/runtime error; switches the screen to the error frame. */
  error: null as string | null,
  /** Terminal size, updated on resize. The layout math keys off this. */
  rows: 24,
  columns: 80,
});

/** Mark the current step done (if any) and begin a new one. */
export function beginStep(label: string): void {
  const last = appStore.steps[appStore.steps.length - 1];
  if (last && last.status === "active") last.status = "done";
  appStore.steps.push({ label, status: "active" });
}

/** Settle the trailing step; called once the boot finishes or dies. */
export function endSteps(ok: boolean): void {
  const last = appStore.steps[appStore.steps.length - 1];
  if (last && last.status === "active") last.status = ok ? "done" : "failed";
}

export function failBoot(message: string): void {
  endSteps(false);
  appStore.error = message;
  appStore.phase = "error";
}

export function resetAppStore(): void {
  appStore.phase = "loading";
  appStore.project = "";
  appStore.steps = [];
  appStore.error = null;
  appStore.rows = 24;
  appStore.columns = 80;
}
