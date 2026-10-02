import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildTestContext, resetDb, authHeaders } from "./helpers/testApp.js";
import { buildEnrollmentWorkbook } from "../src/sheets/enrollmentWorkbook.js";
import { FakeSheetsExporter, toCsv } from "../src/sheets/fakeSheetsExporter.js";
import { parseCsv } from "../src/routes/sheets.js";

describe("spreadsheet export", () => {
  let ctx: Awaited<ReturnType<typeof buildTestContext>>;

  beforeAll(async () => {
    ctx = await buildTestContext();
  });
  afterEach(async () => resetDb(ctx.prisma));
  afterAll(async () => ctx.cleanup());

  async function enrollmentWithTwoRecordings() {
    const participant = await ctx.prisma.participant.create({ data: { contact: "whatsapp:+15550001" } });
    const enrollment = await ctx.prisma.enrollment.create({ data: { participantId: participant.id, casino: "AcmeCasino", state: "wager_submitted" } });
    await ctx.prisma.grant.create({ data: { enrollmentId: enrollment.id, amount: 50, sentAt: new Date("2026-01-01T00:00:00Z") } });

    for (const [n, rows] of [
      [1, [{ ts: "2026-01-01T09:01:00Z", type: "bet", amount: -1, before: 100, after: 99 }, { ts: "2026-01-01T09:00:00Z", type: "deposit", amount: 100, before: 0, after: 100 }]],
      [2, [{ ts: "2026-01-01T09:03:00Z", type: "bet", amount: -2, before: 99, after: 97 }]],
    ] as const) {
      const contentHash = `hash-${n}`;
      const media = await ctx.prisma.mediaAsset.create({ data: { blobKey: contentHash, contentHash, bytes: 10 } });
      const sub = await ctx.prisma.submission.create({
        data: { enrollmentId: enrollment.id, kind: "wager_recording", channel: "dropbox", mediaAssetId: media.id, contentHash, receivedAt: new Date(`2026-01-0${n}T10:00:00Z`) },
      });
      const run = await ctx.prisma.extractionRun.create({
        data: { submissionId: sub.id, extractorVersion: "test", model: "fake", status: "succeeded", quality: { verdict: "ok", reasons: [] } },
      });
      for (const [i, r] of rows.entries()) {
        await ctx.prisma.transactionRow.create({
          data: { extractionRunId: run.id, sequence: i, rowKey: `k${n}${i}`, timestamp: new Date(r.ts), type: r.type, description: `Blackjack ${i}`, amount: r.amount, balanceBefore: r.before, balanceAfter: r.after, crossChecked: true, disagreements: i === 0 && n === 2 ? ["timestamp"] : [] },
        });
      }
      await ctx.prisma.reconciliation.create({
        data: { extractionRunId: run.id, wageredTotal: n, arithmeticOk: true, chainComplete: true, chainStart: n === 1 ? 0 : 99, chainEnd: n === 1 ? 99 : 97, newestFirst: true, chainBreaks: [] },
      });
      await ctx.prisma.integrityFlag.create({ data: { submissionId: sub.id, extractionRunId: run.id, code: "MANUAL_INTAKE", severity: "info", detail: "fixture", generatedBy: "test" } });
    }
    return enrollment;
  }

  it("builds one workbook per enrollment with a Summary tab and a tab per recording", async () => {
    const enrollment = await enrollmentWithTwoRecordings();
    const { workbook, tabBySubmission } = await buildEnrollmentWorkbook(ctx.prisma, enrollment.id, "http://test.local");

    expect(workbook.title).toContain("AcmeCasino");
    expect(workbook.tabs).toHaveLength(3);
    expect(workbook.tabs[0]!.title).toBe("Summary");
    expect(tabBySubmission.size).toBe(2);

    const summary = workbook.tabs[0]!.rows.map((r) => r.join(" | ")).join("\n");
    expect(summary).toContain("whatsapp:+15550001");
    expect(summary).toContain("Total wagered");
    expect(summary).toContain("MANUAL_INTAKE");
    expect(summary).toContain("http://test.local/console#/submission/");

    const recording = workbook.tabs[1]!;
    expect(recording.rows[0]).toEqual(["#", "Timestamp", "Type", "Description", "Amount", "Balance before", "Balance after", "Second read", "Recording time (s)"]);
    expect(recording.rows).toHaveLength(3);
    expect(recording.rows.some((r) => r.includes("agreed"))).toBe(true);
  });

  it("exports through the route, stores the workbook id, and re-exports into the same workbook", async () => {
    const enrollment = await enrollmentWithTwoRecordings();

    const first = await ctx.app.inject({ method: "POST", url: `/enrollments/${enrollment.id}/sheet`, headers: authHeaders() });
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(body.mode).toBe("fake");
    expect(body.tabs).toHaveLength(3);

    const stored = await ctx.prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } });
    expect(stored.sheetDocumentId).toBe(body.documentId);
    expect(stored.sheetUrl).toBe(body.workbookUrl);

    const second = await ctx.app.inject({ method: "POST", url: `/enrollments/${enrollment.id}/sheet`, headers: authHeaders() });
    expect(second.json().documentId).toBe(body.documentId);

    const audit = await ctx.prisma.auditEvent.findMany({ where: { action: "export_sheet", target: enrollment.id } });
    expect(audit).toHaveLength(2);
  });

  it("deep-links a submission's own tab when asked", async () => {
    const enrollment = await enrollmentWithTwoRecordings();
    const sub = await ctx.prisma.submission.findFirstOrThrow({ where: { enrollmentId: enrollment.id }, orderBy: { receivedAt: "asc" } });

    const res = await ctx.app.inject({ method: "POST", url: `/enrollments/${enrollment.id}/sheet?submissionId=${sub.id}`, headers: authHeaders() });
    const body = res.json();
    expect(body.url).not.toBe(body.workbookUrl);
    expect(body.url.startsWith(body.workbookUrl)).toBe(true);
  });

  it("serves the fake workbook's index and tab CSVs", async () => {
    const enrollment = await enrollmentWithTwoRecordings();
    const { documentId, tabs } = (await ctx.app.inject({ method: "POST", url: `/enrollments/${enrollment.id}/sheet`, headers: authHeaders() })).json();

    const index = await ctx.app.inject({ method: "GET", url: `/sheets/${documentId}` });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain("Summary");

    const slug = new URL(tabs[1].url).hash.slice(1);
    const csv = await ctx.app.inject({ method: "GET", url: `/sheets/${documentId}/${slug}.csv` });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body.split("\r\n")[0]).toBe("#,Timestamp,Type,Description,Amount,Balance before,Balance after,Second read,Recording time (s)");
  });

  it("quotes CSV cells that contain commas, quotes or newlines", () => {
    expect(toCsv([["plain", 'say "hi"', "a,b", "line\nbreak", null]])).toBe('plain,"say ""hi""","a,b","line\nbreak",');
  });

  it("re-uses an existing workbook id rather than creating a second one", async () => {
    const exporter = new FakeSheetsExporter(ctx.objectStore, "http://test.local");
    const a = await exporter.export({ title: "W", tabs: [{ title: "Summary", rows: [["a"]] }] }, null);
    const b = await exporter.export({ title: "W", tabs: [{ title: "Recording 1", rows: [["b"]] }] }, a.documentId);
    expect(b.documentId).toBe(a.documentId);
    // The tab added first survives an export that didn't mention it.
    const index = await ctx.app.inject({ method: "GET", url: `/sheets/${a.documentId}` });
    expect(index.body).toContain("Summary");
    expect(index.body).toContain("Recording 1");
  });

  it("renders a tab as a readable table, and round-trips quoted CSV cells", async () => {
    const enrollment = await enrollmentWithTwoRecordings();
    const { documentId } = (await ctx.app.inject({ method: "POST", url: `/enrollments/${enrollment.id}/sheet`, headers: authHeaders() })).json();

    const page = await ctx.app.inject({ method: "GET", url: `/sheets/${documentId}/summary` });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain("<th>Betlab — wager evidence</th>");
    expect(page.body).toContain("Total wagered");
    // A cell containing commas survives the CSV round trip as one cell.
    expect(page.body).toContain("Flags are annotations for a reviewer, not verdicts.");

    const missing = await ctx.app.inject({ method: "GET", url: `/sheets/${documentId}/nope` });
    expect(missing.statusCode).toBe(404);
  });

  it("parses CSV back to the rows it was written from", () => {
    const rows = [["a", 'say "hi"', "a,b", "line\nbreak"], ["1", "2", "3", "4"]];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });

  it("renders timestamps the way the recording showed them, including inside chain-break text", async () => {
    const enrollment = await enrollmentWithTwoRecordings();
    const { workbook } = await buildEnrollmentWorkbook(ctx.prisma, enrollment.id, "http://test.local");
    const cells = workbook.tabs.flatMap((t) => t.rows.flat()).map(String);
    expect(cells.some((c) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(c))).toBe(true);
    expect(cells.some((c) => c.includes("T") && c.includes("Z") && /\d{4}-\d{2}-\d{2}T/.test(c))).toBe(false);
  });
});
