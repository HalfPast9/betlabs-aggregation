import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  compositeSegment,
  planReconstruction,
  sampleDenseFrames,
  tilePanorama,
  locateInFrames,
} from "../src/extraction/panorama.js";
import { makeScrollVideo } from "./helpers/scrollVideo.js";

describe("scroll reconstruction", () => {
  it("recovers the full scrolled list from a recording with static header/footer", async () => {
    const v = await makeScrollVideo({ rowCount: 24, speed: 250 });
    const frames = await sampleDenseFrames(v.buffer, 10);
    try {
      const plan = await planReconstruction(frames);

      // Static chrome excluded from the scroll region (coarse detection: ±10px).
      expect(Math.abs(plan.scrollRegion.top - v.headerHeight)).toBeLessThanOrEqual(10);
      expect(Math.abs(plan.scrollRegion.bottom - (v.height - v.footerHeight))).toBeLessThanOrEqual(10);

      expect(plan.gaps).toHaveLength(0);
      expect(plan.segments).toHaveLength(1);
      const segment = plan.segments[0]!;
      expect(Math.abs(segment.height - v.listHeight) / v.listHeight).toBeLessThan(0.01);

      // Scrolling bottom→top means later frames sit higher in the panorama.
      expect(segment.placements[segment.placements.length - 1]!.top).toBeLessThan(segment.placements[0]!.top);

      const pano = await compositeSegment(frames, plan, segment);
      const meta = await sharp(pano.png).metadata();
      expect(meta.width).toBe(v.width);
      expect(meta.height).toBe(segment.height);

      const tiles = await tilePanorama(pano, 0, 0);
      expect(tiles.length).toBeGreaterThanOrEqual(2);
      expect(tiles[0]!.top).toBe(0);
      expect(tiles[tiles.length - 1]!.bottom).toBe(segment.height);
      // Consecutive tiles overlap by more than a row.
      expect(tiles[0]!.bottom - tiles[1]!.top).toBeGreaterThan(v.rowHeight);

      // A row near the middle of the list maps back to a frame that shows it.
      const regionH = plan.scrollRegion.bottom - plan.scrollRegion.top;
      const loc = locateInFrames(segment, regionH, 1000, 1090);
      expect(loc).not.toBeNull();
      expect(loc!.yInRegion).toBeGreaterThanOrEqual(0);
      expect(loc!.yInRegion + 90).toBeLessThanOrEqual(regionH);
    } finally {
      await frames.cleanup();
    }
  }, 60_000);

  it("survives a flick faster than a screen per frame by splitting into segments with a gap", async () => {
    // 370px viewport at 10fps: 6000px/s moves 600px per sampled frame — no overlap.
    const v = await makeScrollVideo({ rowCount: 20, speed: 6000, fps: 60 });
    const frames = await sampleDenseFrames(v.buffer, 10);
    try {
      const plan = await planReconstruction(frames);
      expect(plan.gaps.length).toBeGreaterThan(0);
      expect(plan.segments.length).toBe(plan.gaps.length + 1);
    } finally {
      await frames.cleanup();
    }
  }, 60_000);
});
