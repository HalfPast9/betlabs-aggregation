import type { PrismaClient } from "@prisma/client";
import type { CellStyle, CellValue, SheetTab, Workbook } from "./exporter.js";
import { buildLedger } from "../extraction/ledger.js";

export interface WorkbookBuild {
  workbook: Workbook;
  /** Tab title per submission, so a submission page can deep-link its own tab. */
  tabBySubmission: Map<string, string>;
}

/**
 * One workbook per enrollment: a Summary tab (what a reviewer needs to decide
 * — totals, the balance-chain verdict, every flag, every clip), then one tab
 * per recording with its extracted rows. Re-exporting refreshes the tabs it
 * builds and leaves any others alone, so a re-run of one recording doesn't
 * disturb the rest.
 */
export async function buildEnrollmentWorkbook(prisma: PrismaClient, enrollmentId: string, consoleBase: string): Promise<WorkbookBuild> {
  const enrollment = await prisma.enrollment.findUniqueOrThrow({
    where: { id: enrollmentId },
    include: {
      participant: true,
      grant: true,
      submissions: {
        orderBy: { receivedAt: "asc" },
        include: {
          integrityFlags: true,
          extractionRuns: {
            where: { status: "succeeded" },
            orderBy: { startedAt: "desc" },
            take: 1,
            include: { rows: { orderBy: { sequence: "asc" } }, reconciliation: true },
          },
        },
      },
    },
  });

  const who = enrollment.participant.contact ?? enrollment.participant.email ?? enrollment.participant.id;
  const ledger = await buildLedger(prisma, enrollmentId);
  const recordings = enrollment.submissions.filter((s) => s.kind === "wager_recording");

  const tabBySubmission = new Map<string, string>();
  const used = new Set<string>(["Summary"]);
  const recordingTabs: SheetTab[] = recordings.map((s, i) => {
    const title = uniqueTitle(`${i + 1}. ${s.receivedAt.toISOString().slice(0, 10)} ${s.id.slice(0, 6)}`, used);
    tabBySubmission.set(s.id, title);
    return { title, rows: recordingRows(s, consoleBase) };
  });

  const rows: CellValue[][] = [];
  const styles: CellStyle[] = [];
  const COLS = 7;
  const put = (...cells: CellValue[]) => rows.push(cells) - 1;
  const blank = () => put("");
  const section = (label: string) => {
    blank();
    styles.push({ kind: "section", row: put(label), span: COLS });
  };
  const field = (label: string, value: CellValue, style?: (row: number) => CellStyle) => {
    const row = put(label, value);
    styles.push({ kind: "label", row });
    if (style) styles.push(style(row));
    return row;
  };

  const titleRow = put("Betlab — wager evidence");
  styles.push({ kind: "title", row: titleRow, span: COLS }, { kind: "merge", row: titleRow, startCol: 0, endCol: COLS });
  const subtitleRow = put(`${who} · ${enrollment.casino} · enrollment ${enrollment.state}`);
  styles.push({ kind: "subtitle", row: subtitleRow, span: COLS }, { kind: "merge", row: subtitleRow, startCol: 0, endCol: COLS });

  section("Funding");
  field("Granted", enrollment.grant ? Number(enrollment.grant.amount) : "not recorded", (row) =>
    enrollment.grant ? { kind: "money", row, col: 1 } : { kind: "verdict", row, col: 1, tone: "muted" },
  );
  field("Granted on", fmtTs(enrollment.grant?.sentAt ?? null));

  section("Across all recordings");
  field("Total wagered", Number(ledger.wageredTotal.toFixed(2)), (row) => ({ kind: "money", row, col: 1 }));
  field("Transactions", ledger.rows.length);
  field("Recordings", ledger.clips.length);
  const chainText =
    ledger.chain.checkedRows === 0
      ? "not checkable — this app's list shows no running balance"
      : ledger.chain.complete
        ? `complete · ${fmt(ledger.chain.startBalance)} → ${fmt(ledger.chain.endBalance)}`
        : `${ledger.chain.breaks.length} break(s)${ledger.betweenClips ? ` · ${ledger.betweenClips} between recordings` : ""}`;
  field("Balance chain", chainText, (row) => ({
    kind: "verdict",
    row,
    col: 1,
    tone: ledger.chain.checkedRows === 0 ? "muted" : ledger.chain.complete ? "good" : "bad",
  }));
  for (const b of ledger.chain.breaks) {
    const row = put(`      at transaction ${b.rowIndex}`, friendlyTimestamps(b.detail));
    styles.push({ kind: "label", row }, { kind: "merge", row, startCol: 1, endCol: COLS });
  }

  section("Recordings");
  styles.push({ kind: "header", row: put("Tab", "Received", "Channel", "Rows", "Balance chain", "Recording quality", "Open in the console"), span: COLS });
  recordings.forEach((s, i) => {
    const run = s.extractionRuns[0];
    const rec = run?.reconciliation;
    const quality = run?.quality as { verdict?: string; reasons?: string[] } | null;
    const chain = !run
      ? "not extracted"
      : rec?.chainComplete === null || rec?.chainComplete === undefined
        ? "not checkable"
        : rec.chainComplete
          ? `complete · ${fmt(rec.chainStart)} → ${fmt(rec.chainEnd)}`
          : `${breakCount(rec.chainBreaks)} break(s)`;
    const link = `${consoleBase}/console#/submission/${s.id}`;
    // The URL is the cell's text, not just a style: a CSV reader has no link
    // formatting to fall back on.
    const row = put(recordingTabs[i]!.title, fmtTs(s.receivedAt), s.channel, run?.rows.length ?? 0, chain, quality ? [quality.verdict, ...(quality.reasons ?? [])].filter(Boolean).join(" — ") : "", link);
    styles.push({ kind: "verdict", row, col: 4, tone: !run ? "muted" : rec?.chainComplete ? "good" : rec?.chainComplete === null ? "muted" : "bad" });
    if (quality?.verdict) styles.push({ kind: "verdict", row, col: 5, tone: quality.verdict === "ok" ? "good" : quality.verdict === "warn" ? "warn" : "bad" });
    styles.push({ kind: "link", row, col: 6, uri: link });
  });

  const flagRows = recordings.flatMap((s, i) => s.integrityFlags.map((f) => ({ tab: recordingTabs[i]!.title, f })));
  section("Integrity flags");
  if (flagRows.length === 0) {
    styles.push({ kind: "subtitle", row: put("None."), span: COLS });
  } else {
    const flagHeader = put("Recording", "Code", "Severity", "Detail");
    styles.push({ kind: "header", row: flagHeader, span: COLS }, { kind: "merge", row: flagHeader, startCol: 3, endCol: COLS });
    for (const { tab, f } of flagRows) {
      const row = put(tab, f.code, f.severity, f.detail ?? "");
      styles.push(
        { kind: "verdict", row, col: 2, tone: f.severity === "high" ? "bad" : f.severity === "warning" ? "warn" : "muted" },
        { kind: "merge", row, startCol: 3, endCol: COLS },
      );
    }
  }

  blank();
  const noteRow = rows.length;
  styles.push({ kind: "merge", row: noteRow, startCol: 0, endCol: COLS });
  styles.push({
    kind: "note",
    row: put(
      `Generated ${fmtTs(new Date())} · Extracted from screen recordings and verified against the balances the app itself displays. Flags are annotations for a reviewer, not verdicts.`,
    ),
    span: COLS,
  });

  const summaryTab: SheetTab = {
    title: "Summary",
    rows,
    headerRow: false,
    columnWidths: [190, 200, 110, 70, 190, 250, 280],
    styles,
  };

  return {
    workbook: { title: `Betlab — ${who} — ${enrollment.casino}`, tabs: [summaryTab, ...recordingTabs] },
    tabBySubmission,
  };
}

interface ExtractedRow {
  sequence: number;
  timestamp: Date | null;
  type: string | null;
  description: string | null;
  amount: unknown;
  balanceBefore: unknown;
  balanceAfter: unknown;
  sourceFrameTs: number | null;
  crossChecked: boolean;
  disagreements: string[];
}

interface RecordingSubmission {
  id: string;
  extractionRuns: Array<{ rows: ExtractedRow[] }>;
}

function recordingRows(submission: RecordingSubmission, consoleBase: string): CellValue[][] {
  const run = submission.extractionRuns[0];
  const header: CellValue[][] = [
    ["#", "Timestamp", "Type", "Description", "Amount", "Balance before", "Balance after", "Second read", "Recording time (s)"],
  ];
  if (!run) return [...header, ["", "not extracted yet", "", `${consoleBase}/console#/submission/${submission.id}`]];
  return [
    ...header,
    ...run.rows.map((r): CellValue[] => [
      r.sequence,
      fmtTs(r.timestamp),
      r.type ?? "",
      r.description ?? "",
      r.amount === null ? "" : Number(r.amount),
      r.balanceBefore === null ? "" : Number(r.balanceBefore),
      r.balanceAfter === null ? "" : Number(r.balanceAfter),
      r.disagreements.length ? `disagreed: ${r.disagreements.join(", ")}` : r.crossChecked ? "agreed" : "",
      r.sourceFrameTs === null ? "" : Number(r.sourceFrameTs.toFixed(1)),
    ]),
  ];
}

function breakCount(breaks: unknown): number {
  return Array.isArray(breaks) ? breaks.length : 0;
}

function fmt(v: number | { toString(): string } | null | undefined): string {
  return v === null || v === undefined ? "—" : Number(v).toFixed(2);
}

/**
 * Timestamps as the recording showed them. Rows were read off a screen and
 * parsed in this machine's timezone, so rendering them back in local time is
 * what matches the video a reviewer is comparing against — an ISO string in
 * UTC would read an hour or five off the app.
 */
/** Chain messages quote whatever timestamp the rows carried; ISO reads badly in a sheet. */
function friendlyTimestamps(detail: string): string {
  return detail.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, (iso) => fmtTs(new Date(iso)));
}

function fmtTs(d: Date | null): string {
  if (!d) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Google rejects duplicate tab titles. */
function uniqueTitle(base: string, used: Set<string>): string {
  let title = base.slice(0, 95);
  let n = 2;
  while (used.has(title)) title = `${base.slice(0, 92)} (${n++})`;
  used.add(title);
  return title;
}
