import { describe, expect, it } from "vitest";
import { checkEncoderMismatch, checkFrameDiscontinuity } from "../src/integrity/videoSignals.js";
import { checkManualIntake, checkSubmissionGap } from "../src/integrity/simpleFlags.js";

describe("checkEncoderMismatch", () => {
  it("flags a known re-encode signature", () => {
    const flag = checkEncoderMismatch({ formatName: "mov,mp4", encoder: "WhatsApp", majorBrand: "isom" });
    expect(flag?.code).toBe("ENCODER_MISMATCH");
  });

  it("does not flag an unrecognized encoder tag", () => {
    const flag = checkEncoderMismatch({ formatName: "mov,mp4", encoder: "com.apple.quicktime.player", majorBrand: "qt" });
    expect(flag).toBeNull();
  });

  it("does not flag when there's no encoder tag at all", () => {
    const flag = checkEncoderMismatch({ formatName: "mov,mp4", encoder: null, majorBrand: null });
    expect(flag).toBeNull();
  });
});

describe("checkFrameDiscontinuity", () => {
  it("does not flag a steady keyframe cadence", () => {
    const flag = checkFrameDiscontinuity([0, 2, 4, 6, 8, 10]);
    expect(flag).toBeNull();
  });

  it("flags a keyframe interval far from the median", () => {
    const flag = checkFrameDiscontinuity([0, 2, 4, 6, 6.1, 16, 18]);
    expect(flag?.code).toBe("FRAME_DISCONTINUITY");
  });

  it("skips when there are too few keyframes to assess", () => {
    expect(checkFrameDiscontinuity([0, 5])).toBeNull();
  });
});

describe("checkManualIntake", () => {
  it("flags manual_upload channel", () => {
    expect(checkManualIntake("manual_upload")?.code).toBe("MANUAL_INTAKE");
  });
  it("does not flag dropbox channel", () => {
    expect(checkManualIntake("dropbox")).toBeNull();
  });
});

describe("checkSubmissionGap", () => {
  it("flags a recording submitted long after the grant", () => {
    const grantSentAt = new Date("2026-01-01T00:00:00Z");
    const receivedAt = new Date("2026-02-01T00:00:00Z");
    expect(checkSubmissionGap(receivedAt, grantSentAt)?.code).toBe("SUBMISSION_GAP");
  });

  it("does not flag a recording submitted shortly after the grant", () => {
    const grantSentAt = new Date("2026-01-01T00:00:00Z");
    const receivedAt = new Date("2026-01-02T00:00:00Z");
    expect(checkSubmissionGap(receivedAt, grantSentAt)).toBeNull();
  });

  it("skips when there's no grant yet", () => {
    expect(checkSubmissionGap(new Date(), null)).toBeNull();
  });
});
