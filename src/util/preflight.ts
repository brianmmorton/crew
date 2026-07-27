import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../types.js";

/** The Node version the repo pins, from .nvmrc or package.json engines.node. */
function wantedNode(repoPath: string): string | null {
  const nvmrc = join(repoPath, ".nvmrc");
  if (existsSync(nvmrc)) {
    const v = readFileSync(nvmrc, "utf8").trim();
    if (v) return v;
  }
  try {
    const pkg = JSON.parse(readFileSync(join(repoPath, "package.json"), "utf8")) as {
      engines?: { node?: string };
    };
    return pkg.engines?.node ?? null;
  } catch {
    return null;
  }
}

/** Locate an nvm-installed node bin dir matching `version` (exact, else newest of that major). */
function findNvmBin(version: string): string | null {
  const nvmDir = process.env.NVM_DIR || join(homedir(), ".nvm");
  const versionsDir = join(nvmDir, "versions", "node");
  if (!existsSync(versionsDir)) return null;

  const exact = version.replace(/^v/, "");
  const installed = readdirSync(versionsDir).filter((d) => d.startsWith("v"));

  let match = installed.find((d) => d === `v${exact}`);
  if (!match) {
    const major = (exact.match(/^(\d+)/) || [])[1];
    if (major) {
      const sameMajor = installed
        .filter((d) => d.startsWith(`v${major}.`))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      match = sameMajor[sameMajor.length - 1];
    }
  }
  if (!match) return null;

  const bin = join(versionsDir, match, "bin");
  return existsSync(join(bin, "node")) ? bin : null;
}

/**
 * Ensure child processes (the agent's shells + the verify gate) run under the
 * repo's pinned Node, not whatever crew was launched with. If crew is already on
 * the right major, do nothing (children inherit it). Otherwise prepend the
 * matching nvm bin to PATH, or warn if it isn't installed.
 */
export function provisionRepoNode(repoPath: string, logger: Logger): void {
  const want = wantedNode(repoPath);
  if (!want) return;

  const wantMajor = (want.match(/(\d+)/) || [])[1];
  const curMajor = process.versions.node.split(".")[0];
  if (!wantMajor || wantMajor === curMajor) return;

  const bin = findNvmBin(want);
  if (bin) {
    process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
    logger.info(`using repo Node ${want} (${bin}) for child processes`);
  } else {
    logger.warn(
      `Node mismatch: repo wants "${want}" but crew runs Node v${process.versions.node}, ` +
        `and no matching nvm install was found. Tests/verify may fail — ` +
        `install it (\`nvm install ${wantMajor}\`) or start crew under the repo's Node.`,
    );
  }
}
