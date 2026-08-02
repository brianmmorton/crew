import { setPaused, wakeExecutor } from "../engine/loop.js";
import { logger } from "../util/logger.js";
import type { Action } from "./keys.js";
import {
  agentsStore,
  moveSelection,
  selectedAgent,
  toggleExpanded,
  type AgentItem,
} from "./stores/agents.js";
import { appStore, focusHistory, focusNext, toggleHistory } from "./stores/app.js";
import { moveHistorySelection, selectedSession } from "./stores/history.js";
import { openExternal } from "./openLink.js";
import { poolStore } from "./stores/pool.js";
import { runsStore } from "./stores/runs.js";
import { startRun, stopRun, toggleRunPause } from "./runManager.js";
import { setSchedulerPaused } from "./scheduler.js";

/**
 * The intent layer between keys.ts and the stores/engine. Every user-visible
 * consequence of a keypress goes through here, and every action narrates
 * itself through the logger — which lands in the OUTPUT panel, so the UI
 * always answers "did that keypress do anything?".
 */

export function dispatch(action: Action, exit: () => void): void {
  switch (action.type) {
    case "up":
      if (appStore.focus === "history") moveHistorySelection(-1);
      else moveSelection(-1);
      return;
    case "down":
      if (appStore.focus === "history") moveHistorySelection(1);
      else moveSelection(1);
      return;
    case "toggle-expand": {
      // Enter follows focus: in the agent list it expands the accordion; in
      // the history panel every row already shows its whole summary, so Enter
      // means "open what this session produced" — the PR in a browser, or the
      // transcript when there is no PR.
      if (appStore.focus === "history") {
        openSelectedSession();
        return;
      }
      const agent = selectedAgent();
      if (agent) toggleExpanded(agent.name);
      return;
    }
    case "collapse-all":
      if (appStore.focus === "history") {
        appStore.focus = "agents";
        return;
      }
      agentsStore.expanded = {};
      return;
    case "toggle-history":
      toggleHistory();
      return;
    case "focus-next":
      focusNext();
      return;
    case "focus-right":
      focusHistory();
      return;
    case "focus-left":
      appStore.focus = "agents";
      return;
    case "open-board":
      if (appStore.boardUrl) {
        logger.info(`opening ${appStore.boardUrl}`);
        openExternal(appStore.boardUrl);
      } else {
        logger.info("no board url — the tracker didn't resolve one at boot");
      }
      return;
    case "run-selected": {
      const agent = selectedAgent();
      if (agent) runAgent(agent);
      return;
    }
    case "run-index": {
      const agent = agentsStore.items[action.index];
      if (agent) {
        agentsStore.selected = action.index;
        runAgent(agent);
      }
      return;
    }
    case "pause-agent": {
      const agent = selectedAgent();
      if (agent) pauseAgent(agent);
      return;
    }
    case "pause-pool":
      togglePoolPause();
      return;
    case "stop-agent": {
      const agent = selectedAgent();
      const status = agent && runsStore.byAgent[agent.name]?.status;
      if (agent && (status === "running" || status === "paused")) {
        logger.info(`stopping ${agent.name}'s run`);
        stopRun(agent.name);
      }
      return;
    }
    case "quit":
      exit();
      return;
  }
}

/**
 * Enter on a history session: hand its most useful artifact to the OS. The PR
 * url when the session produced one — that's the thing you review — otherwise
 * the newest run's transcript, so a failed session is one keypress from its
 * evidence. Narrates either way, so the keypress always visibly did something.
 */
function openSelectedSession(): void {
  const session = selectedSession();
  if (!session) return;
  const target =
    session.prUrl ?? [...session.runs].reverse().find((r) => r.logPath)?.logPath;
  if (!target) {
    logger.info(`${session.label} has nothing to open — no PR or transcript recorded`);
    return;
  }
  logger.info(`opening ${target}`);
  openExternal(target);
}

/**
 * "Run now". Proposers spawn a real `crew once` cycle; the executor is nudged
 * in-process (spawning a second executor would just race the loop for the
 * same claims); reviewers only ever run after a PR opens.
 */
function runAgent(agent: AgentItem): void {
  switch (agent.kind) {
    case "executor":
      if (poolStore.executorPaused) {
        poolStore.executorPaused = false;
        setPaused(false);
      }
      wakeExecutor();
      logger.info(`${agent.name} nudged — claiming the next ready item`);
      return;
    case "reviewer":
      logger.info(`${agent.name} is a reviewer — it runs automatically after a PR opens`);
      return;
    default: {
      if (runsStore.byAgent[agent.name]?.status === "running") {
        logger.info(`${agent.name} is already running`);
        return;
      }
      // A drain agent's run key starts the whole run-to-completion session —
      // one child that loops until its goal is met — not a single cycle.
      const verb = agent.mode === "drain" ? "drain" : "once";
      logger.info(
        verb === "drain"
          ? `starting ${agent.name} drain session (crew drain ${agent.name}) — runs until done`
          : `starting ${agent.name} (crew once ${agent.name})`,
      );
      startRun(agent.name, verb);
      agentsStore.expanded[agent.name] = true;
    }
  }
}

/**
 * Space on an agent: freeze/thaw its live run (SIGSTOP/SIGCONT). On the
 * executor row — which has no child process — it pauses the pool instead,
 * so "pause the thing under the cursor" always does the obvious thing.
 */
function pauseAgent(agent: AgentItem): void {
  if (agent.kind === "executor") {
    togglePoolPause();
    return;
  }
  const status = runsStore.byAgent[agent.name]?.status;
  if (status !== "running" && status !== "paused") {
    logger.info(`${agent.name} has no live run to pause`);
    return;
  }
  toggleRunPause(agent.name);
  logger.info(status === "running" ? `${agent.name} paused (SIGSTOP)` : `${agent.name} resumed`);
}

/**
 * Pause the worker pool: workers finish the cycle they're on but claim no
 * NEW work until resumed. Resume also wakes any worker sleeping out a poll
 * interval, so it picks work up immediately.
 *
 * Scheduled proposers pause with it — otherwise a pause would keep filing new
 * work into a board nothing is draining.
 */
export function togglePoolPause(): void {
  const next = !poolStore.executorPaused;
  poolStore.executorPaused = next;
  setPaused(next);
  setSchedulerPaused(next);
  if (next) {
    logger.info("paused — finishing in-flight cycles, claiming no new work, proposers held");
  } else {
    wakeExecutor();
    logger.info("resumed");
  }
}
