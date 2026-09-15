import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { checkDropboxQuota } from "../src/jobs/monitorDropboxQuota.js";
import { FakeDropboxClient } from "../src/dropbox/fakeClient.js";
import { resetDb } from "./helpers/testApp.js";

describe("checkDropboxQuota", () => {
  const prisma = new PrismaClient();

  beforeAll(async () => {
    await resetDb(prisma);
  });
  afterEach(async () => {
    await resetDb(prisma);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("does not warn when usage is well under the threshold", async () => {
    const dropbox = new FakeDropboxClient();
    dropbox.seedFile("/betlab-intake/e1/small.mp4", Buffer.alloc(1024));

    const result = await checkDropboxQuota(prisma, dropbox, 0.9);
    expect(result.warned).toBe(false);

    const events = await prisma.auditEvent.findMany({ where: { action: "dropbox_quota_warning" } });
    expect(events).toHaveLength(0);
  });

  it("warns and writes an audit event once usage crosses the threshold", async () => {
    const dropbox = new FakeDropboxClient();
    const usage = await dropbox.getSpaceUsage();
    const almostFull = Math.floor(usage.allocatedBytes! * 0.95);
    dropbox.seedFileWithReportedSize("/betlab-intake/e1/big.mp4", Buffer.alloc(1024), almostFull);

    const result = await checkDropboxQuota(prisma, dropbox, 0.9);
    expect(result.warned).toBe(true);

    const events = await prisma.auditEvent.findMany({ where: { action: "dropbox_quota_warning" } });
    expect(events).toHaveLength(1);
    expect(events[0]?.actor).toBe("system");
  });
});
