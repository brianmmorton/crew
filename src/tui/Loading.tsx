import { memo } from "react";
import { Box, Text } from "ink";
import { useSnapshot } from "valtio";
import { appStore } from "./stores/app.js";
import { useTick } from "./Spinner.js";

/**
 * The boot splash: a little crew boat rows across the terminal while the
 * boot checklist fills in below it. Pinned to the same frame height as the
 * dashboard so the loading→ready transition never grows the frame (Ink's
 * incremental renderer requires a non-growing frame; see layout.ts).
 */

/** Oar positions cycle through a stroke: reach → pull → recover. */
const OAR_PHASES = ["\\  \\  \\  \\", "|  |  |  |", "/  /  /  /", "|  |  |  |"];

function boatLines(phase: number): string[] {
  return [
    "        ⚑",
    "   _____|_________",
    "   \\  c  r  e  w  \\",
    "    \\______________\\",
    `      ${OAR_PHASES[phase % OAR_PHASES.length]}`,
  ];
}

/** An endless swell the boat rides on, scrolling opposite its travel. */
function waveLine(width: number, tick: number): string {
  const pattern = "~ ~ ˜ ~ ";
  const shift = tick % pattern.length;
  return (pattern.repeat(Math.ceil((width + pattern.length) / pattern.length))).slice(
    shift,
    shift + width,
  );
}

const Boat = memo(function Boat({ columns }: { columns: number }): React.ReactNode {
  const tick = useTick();
  const width = Math.max(40, columns);
  const artWidth = 24;
  // Glide across, wrapping back to the left edge like a lap of the harbor.
  const travel = Math.max(1, width - artWidth - 4);
  const x = Math.floor(tick / 2) % travel;
  const pad = " ".repeat(x);
  return (
    <Box flexDirection="column">
      {boatLines(Math.floor(tick / 3)).map((line, i) => (
        <Text key={i} color="cyanBright" wrap="truncate-end">
          {pad}
          {line}
        </Text>
      ))}
      <Text color="blueBright" wrap="truncate-end">
        {waveLine(width - 2, tick)}
      </Text>
    </Box>
  );
});

const StepList = memo(function StepList(): React.ReactNode {
  const steps = useSnapshot(appStore).steps;
  const tick = useTick();
  const dots = ".".repeat((tick % 3) + 1);
  return (
    <Box flexDirection="column" paddingLeft={3}>
      {steps.map((step) => (
        <Text key={step.label}>
          {step.status === "done" && <Text color="green">  ✔ </Text>}
          {step.status === "failed" && <Text color="red">  ✖ </Text>}
          {step.status === "active" && <Text color="cyan">  ⚓ </Text>}
          <Text color={step.status === "active" ? "white" : undefined} dimColor={step.status !== "active"}>
            {step.label}
            {step.status === "active" ? dots : ""}
          </Text>
        </Text>
      ))}
    </Box>
  );
});

export function Loading(): React.ReactNode {
  const snap = useSnapshot(appStore);
  const frameH = Math.max(12, snap.rows - 2);
  return (
    <Box flexDirection="column" height={frameH} paddingLeft={1}>
      <Box height={1} />
      <Text bold color="cyan" wrap="truncate-end">
        {"  crew "}
        <Text dimColor>— shipping out</Text>
      </Text>
      <Box height={1} />
      <Boat columns={snap.columns} />
      <Box height={1} />
      <StepList />
      <Box flexGrow={1} />
      <Text dimColor wrap="truncate-end">{"  ctrl-c to abandon ship"}</Text>
    </Box>
  );
}
