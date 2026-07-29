import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

/**
 * Incremental tail of a growing log file. Holds a byte offset between reads
 * so each poll costs only the new bytes — recreating this per tick would
 * re-read the trailing window every second.
 */
export class LogTail {
  private offset = 0;
  private inode: number | null = null;

  constructor(
    private readonly path: string,
    /** How much history the first read returns (bytes from the end). */
    private readonly seedBytes = 64_000,
  ) {}

  /** New complete lines appended since the last call, oldest first. */
  read(): string[] {
    if (!existsSync(this.path)) return [];
    const st = statSync(this.path);
    // A rotated/truncated file has a new inode or a smaller size; start over
    // rather than seeking a stale offset into new data.
    if (st.ino !== this.inode || st.size < this.offset) {
      this.inode = st.ino;
      this.offset = Math.max(0, st.size - this.seedBytes);
    }
    if (st.size === this.offset) return [];

    const fd = openSync(this.path, "r");
    try {
      const length = st.size - this.offset;
      const buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, this.offset);
      this.offset = st.size;
      const lines = buf.toString("utf8").split("\n");
      // A partial trailing line (write in progress) goes back for next time.
      const partial = lines.pop() ?? "";
      this.offset -= Buffer.byteLength(partial, "utf8");
      return lines.filter((l) => l.length > 0);
    } finally {
      closeSync(fd);
    }
  }
}
