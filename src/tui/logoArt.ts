import { Jimp } from "jimp";

/** One character cell of converted logo art: a glyph plus its source pixel color. */
export interface LogoCell {
  ch: string;
  color: string;
}

// readonly so a valtio useSnapshot() (which deep-readonlys everything) can
// still be passed to Logo/LoadingSplash without a cast.
export type LogoArt = readonly (readonly LogoCell[])[];

// Darkest to lightest. Rendered against the terminal's own background, so pure
// white/black source pixels still read fine either way.
const RAMP = " .:-=+*#%@";

// Terminal cells are roughly twice as tall as wide, so undoing that keeps
// square source images from looking stretched vertically.
const CELL_ASPECT = 2.1;

/**
 * Fetch an image URL and convert it to a small grid of ASCII cells sized to
 * fit within maxWidth x maxHeight. Returns null on any failure (bad URL,
 * network error, undecodable image) so callers can fall back to plain text —
 * a broken logoUrl should degrade the header, never crash the TUI.
 */
export async function fetchLogoArt(
  url: string,
  maxWidth: number,
  maxHeight: number,
): Promise<LogoArt | null> {
  try {
    const image = await Jimp.read(url);
    const srcW = image.bitmap.width;
    const srcH = image.bitmap.height;
    if (!srcW || !srcH) return null;

    let width = Math.min(maxWidth, srcW);
    let height = Math.round((width / srcW) * srcH / CELL_ASPECT);
    if (height > maxHeight) {
      height = maxHeight;
      width = Math.round(((height * CELL_ASPECT) / srcH) * srcW);
    }
    width = Math.max(1, width);
    height = Math.max(1, height);

    image.resize({ w: width, h: height });

    const art: LogoCell[][] = [];
    for (let y = 0; y < height; y++) {
      const row: LogoCell[] = [];
      for (let x = 0; x < width; x++) {
        const { r, g, b, a } = intToRgba(image.getPixelColor(x, y));
        if (a < 32) {
          row.push({ ch: " ", color: "#000000" });
          continue;
        }
        const brightness = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
        const ch = RAMP[Math.min(RAMP.length - 1, Math.floor(brightness * RAMP.length))];
        row.push({ ch, color: rgbToHex(r, g, b) });
      }
      art.push(row);
    }
    return art;
  } catch {
    return null;
  }
}

function intToRgba(i: number): { r: number; g: number; b: number; a: number } {
  return {
    r: (i >>> 24) & 0xff,
    g: (i >>> 16) & 0xff,
    b: (i >>> 8) & 0xff,
    a: i & 0xff,
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}
