import { useEffect } from "react";
import { useApp, useInput, useStdout } from "ink";
import { useSnapshot } from "valtio";
import type { CrewConfig } from "../types.js";
import { keyToAction } from "./keys.js";
import { dispatch } from "./actions.js";
import { startBackground, stopBackground } from "./bootstrap.js";
import { appStore } from "./stores/app.js";
import { debugFilePath, startDebug, stopDebug } from "./debug.js";
import { Loading } from "./Loading.js";
import { Dashboard } from "./Dashboard.js";
import { ErrorScreen } from "./ErrorScreen.js";

/**
 * Root component: lifecycle + input + screen switch, nothing else. All data
 * flows through the stores (see stores/), all layout lives in Dashboard, so
 * this component re-renders only when the PHASE changes.
 */
export function App({ cfg, verbose }: { cfg: CrewConfig; verbose: boolean }): React.ReactNode {
  const { exit } = useApp();
  const { stdout } = useStdout();

  useEffect(() => {
    if (verbose) startDebug(debugFilePath(cfg.configDir));
    void startBackground(cfg);
    return () => {
      stopBackground();
      stopDebug();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- boot once
  }, []);

  useEffect(() => {
    const onResize = () => {
      appStore.rows = stdout?.rows ?? 24;
      appStore.columns = stdout?.columns ?? 80;
    };
    onResize();
    stdout?.on("resize", onResize);
    return () => {
      stdout?.off("resize", onResize);
    };
  }, [stdout]);

  useInput((input, key) => {
    const action = keyToAction(input, key);
    if (action) dispatch(action, exit);
  });

  const phase = useSnapshot(appStore).phase;
  if (phase === "loading") return <Loading />;
  if (phase === "error") return <ErrorScreen />;
  return <Dashboard />;
}
