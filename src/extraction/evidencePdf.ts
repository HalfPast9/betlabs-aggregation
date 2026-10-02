import PDFDocument from "pdfkit";
import sharp from "sharp";

export interface EvidencePdfInput {
  submissionId: string;
  casino: string;
  participant: string;
  receivedAt: Date;
  run: {
    id: string;
    model: string;
    extractorVersion: string;
    startedAt: Date;
    quality: { verdict: string; reasons: string[] } | null;
  };
  reconciliation: {
    wageredTotal: number;
    grantedAmount: number | null;
    chainComplete: boolean | null;
    chainStart: number | null;
    chainEnd: number | null;
    chainBreaks: Array<{ rowIndex: number; detail: string }>;
  } | null;
  flags: Array<{ code: string; severity: string; detail: string | null }>;
  rows: Array<{
    sequence: number;
    timestamp: Date | null;
    type: string | null;
    description: string | null;
    amount: number | null;
    balanceBefore: number | null;
    balanceAfter: number | null;
    disagreements: string[];
  }>;
  /** The stitched list, PNG. */
  panorama: Buffer | null;
}

/**
 * A self-contained evidence document for disputes (docs/extraction-hardening.md
 * §10): what was recorded (the stitched list, paged), what was read from it,
 * and what the checks concluded.
 */
export async function renderEvidencePdf(input: EvidencePdfInput): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 40, info: { Title: `Wager evidence — submission ${input.submissionId}` } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  const money = (v: number | null) => (v === null ? "—" : v.toFixed(2));
  const pageW = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.fontSize(16).text("Wager recording evidence", { continued: false });
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor("#444");
  doc.text(`Submission ${input.submissionId}`);
  doc.text(`${input.casino} · ${input.participant} · received ${input.receivedAt.toISOString()}`);
  doc.text(`Extraction run ${input.run.id} · ${input.run.model} · extractor ${input.run.extractorVersion} · ${input.run.startedAt.toISOString()}`);
  doc.fillColor("#000").moveDown(0.8);

  doc.fontSize(12).text("Verdicts");
  doc.fontSize(10);
  if (input.run.quality) {
    doc.text(`Recording quality: ${input.run.quality.verdict}${input.run.quality.reasons.length ? " — " + input.run.quality.reasons.join("; ") : ""}`);
  }
  if (input.reconciliation) {
    const r = input.reconciliation;
    doc.text(`Wagered total: ${money(r.wageredTotal)}${r.grantedAmount !== null ? ` (granted ${money(r.grantedAmount)})` : ""}`);
    const chain =
      r.chainComplete === null
        ? "not checkable (no running balance shown)"
        : r.chainComplete
          ? `complete, ${money(r.chainStart)} → ${money(r.chainEnd)}`
          : `${r.chainBreaks.length} break(s): ${r.chainBreaks.map((b) => `row ${b.rowIndex} — ${b.detail}`).join("; ")}`;
    doc.text(`Balance chain: ${chain}`);
  }
  if (input.flags.length) {
    doc.moveDown(0.3).text("Flags:");
    for (const f of input.flags) doc.text(`• ${f.code} (${f.severity})${f.detail ? ": " + f.detail : ""}`, { indent: 10 });
  }
  doc.moveDown(0.8);

  doc.fontSize(12).text(`Rows (${input.rows.length})`);
  doc.moveDown(0.2);
  const cols = [
    { key: "seq", w: 24, label: "#" },
    { key: "ts", w: 110, label: "Timestamp" },
    { key: "type", w: 58, label: "Type" },
    { key: "desc", w: 170, label: "Description" },
    { key: "amt", w: 55, label: "Amount", align: "right" as const },
    { key: "bal", w: 95, label: "Balance" },
  ];
  const drawHeader = () => {
    let x = doc.page.margins.left;
    doc.fontSize(8).fillColor("#666");
    for (const c of cols) {
      doc.text(c.label, x, doc.y, { width: c.w, align: c.align ?? "left", continued: false, lineBreak: false });
      x += c.w + 4;
    }
    doc.moveDown(0.6).fillColor("#000");
  };
  drawHeader();
  for (const row of input.rows) {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 20) {
      doc.addPage();
      drawHeader();
    }
    const y = doc.y;
    const cells: Record<string, string> = {
      seq: String(row.sequence),
      ts: row.timestamp ? row.timestamp.toISOString().replace("T", " ").slice(0, 16) : "—",
      type: row.type ?? "—",
      desc: (row.description ?? "—").slice(0, 44),
      amt: money(row.amount),
      bal: row.balanceBefore !== null ? `${money(row.balanceBefore)} → ${money(row.balanceAfter)}` : money(row.balanceAfter),
    };
    let x = doc.page.margins.left;
    doc.fontSize(8).fillColor(row.disagreements.length ? "#a66" : "#000");
    for (const c of cols) {
      doc.text(cells[c.key]!, x, y, { width: c.w, align: c.align ?? "left", lineBreak: false });
      x += c.w + 4;
    }
    doc.y = y + 11;
  }
  doc.fillColor("#000");

  if (input.panorama) {
    const meta = await sharp(input.panorama).metadata();
    const width = meta.width!;
    const height = meta.height!;
    const usableH = doc.page.height - doc.page.margins.top - doc.page.margins.bottom - 30;
    const scale = Math.min(1, pageW / width);
    const sliceH = Math.floor(usableH / scale);
    let top = 0;
    let part = 1;
    while (top < height) {
      const h = Math.min(sliceH, height - top);
      const slice = await sharp(input.panorama).extract({ left: 0, top, width, height: h }).png().toBuffer();
      doc.addPage();
      doc.fontSize(10).fillColor("#444").text(`Stitched recording — part ${part}`).fillColor("#000");
      doc.image(slice, doc.page.margins.left, doc.y + 4, { width: Math.round(width * scale) });
      top += h;
      part++;
    }
  }

  doc.end();
  return done;
}
