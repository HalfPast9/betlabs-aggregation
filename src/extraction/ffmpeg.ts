import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runFfmpeg(args: string[]): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (c) => stdoutChunks.push(c));
    child.stderr.on("data", (c) => stderrChunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-2000)}`));
        return;
      }
      resolve({ stdout: Buffer.concat(stdoutChunks), stderr });
    });
  });
}

const THUMB_WIDTH = 9;
const THUMB_HEIGHT = 8;

/**
 * Difference-hash (dHash) of a frame: downscale to a tiny grayscale bitmap
 * via ffmpeg, then compare each pixel to its right neighbor. Two visually
 * similar frames produce hashes with a small Hamming distance — cheap
 * near-duplicate detection without an image library (PRD §6.3: "drop
 * near-identical frames ... to avoid paying to read a static screen 40 times").
 */
export async function computeDHash(jpegBuffer: Buffer): Promise<bigint> {
  const dir = await mkdtemp(join(tmpdir(), "betlab-thumb-"));
  try {
    const inputPath = join(dir, "frame.jpg");
    await writeFile(inputPath, jpegBuffer);
    const { stdout } = await runFfmpeg([
      "-y",
      "-i",
      inputPath,
      "-vf",
      `scale=${THUMB_WIDTH}:${THUMB_HEIGHT}:flags=area,format=gray`,
      "-f",
      "rawvideo",
      "-frames:v",
      "1",
      "pipe:1",
    ]);

    if (stdout.length < THUMB_WIDTH * THUMB_HEIGHT) {
      throw new Error(`Expected ${THUMB_WIDTH * THUMB_HEIGHT} gray bytes, got ${stdout.length}`);
    }

    let hash = 0n;
    for (let row = 0; row < THUMB_HEIGHT; row++) {
      for (let col = 0; col < THUMB_WIDTH - 1; col++) {
        const left = stdout[row * THUMB_WIDTH + col]!;
        const right = stdout[row * THUMB_WIDTH + col + 1]!;
        hash = (hash << 1n) | (left > right ? 1n : 0n);
      }
    }
    return hash;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x > 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

function runFfprobe(args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (c) => stdoutChunks.push(c));
    child.stderr.on("data", (c) => stderrChunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited with code ${code}: ${Buffer.concat(stderrChunks).toString("utf8").slice(-2000)}`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdoutChunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
  });
}

export interface VideoFormatInfo {
  formatName: string | null;
  encoder: string | null;
  majorBrand: string | null;
}

/** PRD §7 ENCODER_MISMATCH — container/encoder metadata inspection. */
export async function probeFormat(videoBuffer: Buffer): Promise<VideoFormatInfo> {
  const dir = await mkdtemp(join(tmpdir(), "betlab-probe-"));
  try {
    const inputPath = join(dir, "input.mp4");
    await writeFile(inputPath, videoBuffer);
    const result = (await runFfprobe([
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_format",
      inputPath,
    ])) as { format?: { format_name?: string; tags?: Record<string, string> } };

    const tags = result.format?.tags ?? {};
    return {
      formatName: result.format?.format_name ?? null,
      encoder: tags.encoder ?? tags.Encoder ?? null,
      majorBrand: tags.major_brand ?? null,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** PRD §7 FRAME_DISCONTINUITY — keyframe timing, as a proxy for splicing. */
export async function probeKeyframeTimes(videoBuffer: Buffer): Promise<number[]> {
  const dir = await mkdtemp(join(tmpdir(), "betlab-probe-"));
  try {
    const inputPath = join(dir, "input.mp4");
    await writeFile(inputPath, videoBuffer);
    const result = (await runFfprobe([
      "-v",
      "quiet",
      "-select_streams",
      "v:0",
      "-show_entries",
      "frame=key_frame,pts_time",
      "-of",
      "json",
      inputPath,
    ])) as { frames?: Array<{ key_frame?: number; pts_time?: string }> };

    return (result.frames ?? [])
      .filter((f) => f.key_frame === 1 && f.pts_time !== undefined)
      .map((f) => Number.parseFloat(f.pts_time!));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
