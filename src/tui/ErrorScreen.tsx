import { Box, Text } from "ink";
import { useSnapshot } from "valtio";
import { appStore } from "./stores/app.js";

/** Fatal boot failure — same pinned height as every other screen. */
export function ErrorScreen(): React.ReactNode {
  const snap = useSnapshot(appStore);
  const frameH = Math.max(12, snap.rows - 2);
  return (
    <Box flexDirection="column" height={frameH} paddingLeft={1}>
      <Box height={1} />
      <Box borderStyle="round" borderColor="red" flexDirection="column" paddingX={2} width={70}>
        <Text bold color="red">
          ✘ crew ran aground
        </Text>
        <Box height={1} />
        <Text wrap="wrap">{snap.error ?? "unknown error"}</Text>
        <Box height={1} />
        <Text dimColor>check .crew/config.yaml and credentials, then relaunch — q to quit</Text>
      </Box>
      <Box flexGrow={1} />
    </Box>
  );
}
