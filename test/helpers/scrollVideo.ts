import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

const execFileAsync = promisify(execFile);

export interface ScrollVideoSpec {
  width?: number;
  height?: number;
  /** Static chrome at the top/bottom of every frame, like an app header and nav bar. */
  headerHeight?: number;
  footerHeight?: number;
  rowCount?: number;
  rowHeight?: number;
  /** Scroll speed in px/s of list content; the whole list is scrolled bottom→top. */
  speed?: number;
  fps?: number;
}

export interface ScrollVideo {
  buffer: Buffer;
  width: number;
  height: number;
  listHeight: number;
  rowHeight: number;
  headerHeight: number;
  footerHeight: number;
}

/**
 * Renders a fake "transaction list" — rows of dark bars whose widths differ
 * per row so every row is visually distinct — as a tall image, then records
 * a phone-style screen recording of it scrolling under a static header and
 * footer. Ground truth for the panorama reconstruction: the recovered list
 * height must match `listHeight`.
 */
export async function makeScrollVideo(spec: ScrollVideoSpec = {}): Promise<ScrollVideo> {
  const width = spec.width ?? 320;
  const height = spec.height ?? 480;
  const headerHeight = spec.headerHeight ?? 60;
  const footerHeight = spec.footerHeight ?? 50;
  const rowCount = spec.rowCount ?? 24;
  const rowHeight = spec.rowHeight ?? 90;
  const speed = spec.speed ?? 250;
  const fps = spec.fps ?? 30;

  const viewport = height - headerHeight - footerHeight;
  const listHeight = rowCount * rowHeight;

  // Each row is a distinct "barcode" of small blocks (positions from a
  // per-row hash) plus a label, so that — like real text — only the true
  // alignment matches and a shifted one scores badly.
  const rows: string[] = [];
  for (let i = 0; i < rowCount; i++) {
    const y = i * rowHeight;
    let h = (i + 1) * 2654435761;
    for (let k = 0; k < 3; k++) {
      let x = 12;
      while (x < width - 30) {
        h = (h ^ (h >>> 13)) * 1274126177;
        h >>>= 0;
        const w = 6 + (h % 22);
        const gap = 4 + ((h >>> 8) % 18);
        if ((h >>> 16) % 3 !== 0) rows.push(`<rect x="${x}" y="${y + 12 + k * 20}" width="${w}" height="12" fill="${k === 0 ? "#222" : k === 1 ? "#555" : "#a33"}"/>`);
        x += w + gap;
      }
    }
    rows.push(`<text x="12" y="${y + 80}" font-family="monospace" font-size="12" fill="#333">row ${i} #${((i + 1) * 7919) % 10007}</text>`);
    rows.push(`<line x1="0" y1="${y + rowHeight - 1}" x2="${width}" y2="${y + rowHeight - 1}" stroke="#ccc"/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${listHeight}"><rect width="100%" height="100%" fill="#fff"/>${rows.join("")}</svg>`;

  const dir = await mkdtemp(join(tmpdir(), "betlab-scrollvideo-"));
  try {
    const tallPath = join(dir, "tall.png");
    await sharp(Buffer.from(svg)).png().toFile(tallPath);
    const outPath = join(dir, "out.mp4");
    const travel = listHeight - viewport;
    const duration = travel / speed + 1;
    // Start at the bottom of the list and scroll up; pad the top so the crop
    // can never exceed the image, then overlay static chrome.
    const filter = [
      `[0:v]crop=${width}:${viewport}:0:'max(0,${travel}-${speed}*t)'[list]`,
      `color=c=#202020:s=${width}x${headerHeight}:r=${fps}[hdr]`,
      `color=c=#303030:s=${width}x${footerHeight}:r=${fps}[ftr]`,
      `[hdr][list][ftr]vstack=inputs=3,format=yuv420p[out]`,
    ].join(";");
    await execFileAsync("ffmpeg", [
      "-y",
      "-loop",
      "1",
      "-framerate",
      String(fps),
      "-i",
      tallPath,
      "-filter_complex",
      filter,
      "-map",
      "[out]",
      "-t",
      duration.toFixed(2),
      "-r",
      String(fps),
      outPath,
    ]);
    return { buffer: await readFile(outPath), width, height, listHeight, rowHeight, headerHeight, footerHeight };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function writeTmp(buffer: Buffer, name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "betlab-"));
  const p = join(dir, name);
  await writeFile(p, buffer);
  return p;
}
