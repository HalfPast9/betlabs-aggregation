import { GoogleServiceAccount, type ServiceAccountKey } from "./googleAuth.js";
import type { CellStyle, ExportedWorkbook, SheetsExporter, SheetTab, Workbook } from "./exporter.js";

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive.file"];

interface SheetProperties {
  sheetId: number;
  title: string;
  gridProperties?: { rowCount?: number; columnCount?: number };
}

interface Spreadsheet {
  spreadsheetId: string;
  spreadsheetUrl: string;
  sheets?: Array<{ properties: SheetProperties }>;
}

export interface GoogleSheetsExporterOptions {
  serviceAccount: ServiceAccountKey;
  /** Emails the created workbook is shared with (writer). Without these nobody can open it. */
  shareWith: string[];
  /** Optional Drive folder to create workbooks in — must already be shared with the service account. */
  folderId?: string;
}

/**
 * Google Sheets via the REST API. The workbook is created by the service
 * account and immediately shared with `shareWith`, because a file a service
 * account owns is invisible to humans otherwise.
 *
 * Re-exporting rewrites the same workbook: tabs in the payload are replaced,
 * tabs that aren't are left alone, so an enrollment's sheet accumulates a tab
 * per recording and a re-run of extraction refreshes just that one.
 */
export class GoogleSheetsExporter implements SheetsExporter {
  readonly kind = "google" as const;
  private readonly auth: GoogleServiceAccount;

  constructor(private readonly opts: GoogleSheetsExporterOptions) {
    this.auth = new GoogleServiceAccount(opts.serviceAccount, SCOPES);
  }

  async export(workbook: Workbook, documentId: string | null): Promise<ExportedWorkbook> {
    const existing = documentId ? await this.load(documentId) : null;
    const doc = existing ?? (await this.create(workbook));
    const byTitle = new Map((doc.sheets ?? []).map((s) => [s.properties.title, s.properties]));

    // Make any tab we don't have yet, in one batch.
    const missing = workbook.tabs.filter((t) => !byTitle.has(t.title));
    if (missing.length > 0) {
      const res = await this.auth.api<{ replies?: Array<{ addSheet?: { properties: SheetProperties } }> }>(
        `${SHEETS_API}/${doc.spreadsheetId}:batchUpdate`,
        { method: "POST", body: { requests: missing.map((t) => ({ addSheet: { properties: { title: t.title } } })) } },
      );
      for (const reply of res.replies ?? []) {
        if (reply.addSheet) byTitle.set(reply.addSheet.properties.title, reply.addSheet.properties);
      }
    }

    // Values: clear what each tab had, then write. (A shorter tab must not
    // leave the previous export's trailing rows behind.)
    await this.auth.api(`${SHEETS_API}/${doc.spreadsheetId}/values:batchClear`, {
      method: "POST",
      body: { ranges: workbook.tabs.map((t) => `'${escapeTitle(t.title)}'`) },
    });
    await this.auth.api(`${SHEETS_API}/${doc.spreadsheetId}/values:batchUpdate`, {
      method: "POST",
      body: {
        valueInputOption: "RAW",
        data: workbook.tabs.map((t) => ({ range: `'${escapeTitle(t.title)}'!A1`, values: t.rows.map((r) => r.map(cell)) })),
      },
    });

    const formatting = workbook.tabs.flatMap((t) => formatRequests(byTitle.get(t.title)!.sheetId, t));
    if (formatting.length > 0) {
      await this.auth.api(`${SHEETS_API}/${doc.spreadsheetId}:batchUpdate`, { method: "POST", body: { requests: formatting } });
    }

    if (!existing) await this.share(doc.spreadsheetId);

    const url = doc.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${doc.spreadsheetId}/edit`;
    return {
      url,
      documentId: doc.spreadsheetId,
      tabs: workbook.tabs.map((t) => ({ title: t.title, url: `${url}#gid=${byTitle.get(t.title)!.sheetId}` })),
    };
  }

  private async load(spreadsheetId: string): Promise<Spreadsheet | null> {
    try {
      return await this.auth.api<Spreadsheet>(`${SHEETS_API}/${spreadsheetId}?fields=spreadsheetId,spreadsheetUrl,sheets.properties`);
    } catch (err) {
      // Deleted in Drive, or the key was rotated to a different project: start over.
      if (/\(40[34]\)/.test((err as Error).message)) return null;
      throw err;
    }
  }

  /**
   * Google removed Drive storage from service accounts, so a service account
   * can no longer *own* a file: creating a spreadsheet the direct way fails
   * with a bare 403. Inside a Shared Drive the storage belongs to the drive,
   * not the creator, so Drive creates the file there and the Sheets API then
   * fills it in. Without a folder we still try the direct route, which is
   * what a user-owned (OAuth) credential would use.
   */
  private async create(workbook: Workbook): Promise<Spreadsheet> {
    if (!this.opts.folderId) {
      try {
        return await this.auth.api<Spreadsheet>(SHEETS_API, {
          method: "POST",
          body: { properties: { title: workbook.title }, sheets: workbook.tabs.map((t) => ({ properties: { title: t.title } })) },
        });
      } catch (err) {
        if (/\(403\)/.test((err as Error).message)) {
          throw new Error(
            `${(err as Error).message} — a service account has no Drive storage of its own, so it can't create a spreadsheet. ` +
              `Set SHEETS_DRIVE_FOLDER_ID to a Shared Drive (or a folder in one) that ${this.auth.email} is a member of. See docs/google-sheets-setup.md.`,
          );
        }
        throw err;
      }
    }

    const file = await this.auth.api<{ id: string }>(`${DRIVE_API}?supportsAllDrives=true&fields=id`, {
      method: "POST",
      body: { name: workbook.title, mimeType: "application/vnd.google-apps.spreadsheet", parents: [this.opts.folderId] },
    });
    // A Drive-created spreadsheet comes with one default tab; swap it for ours.
    const fresh = await this.auth.api<Spreadsheet>(`${SHEETS_API}/${file.id}?fields=spreadsheetId,spreadsheetUrl,sheets.properties`);
    const defaults = (fresh.sheets ?? []).map((sh) => sh.properties);
    const res = await this.auth.api<{ replies?: Array<{ addSheet?: { properties: SheetProperties } }> }>(`${SHEETS_API}/${file.id}:batchUpdate`, {
      method: "POST",
      body: {
        requests: [
          ...workbook.tabs.map((t) => ({ addSheet: { properties: { title: t.title } } })),
          ...defaults.filter((d) => !workbook.tabs.some((t) => t.title === d.title)).map((d) => ({ deleteSheet: { sheetId: d.sheetId } })),
        ],
      },
    });
    return {
      spreadsheetId: file.id,
      spreadsheetUrl: fresh.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${file.id}/edit`,
      sheets: (res.replies ?? []).flatMap((r) => (r.addSheet ? [{ properties: r.addSheet.properties }] : [])),
    };
  }

  /**
   * Named people get explicit access. In a Shared Drive the drive's own
   * members can already open it, so a refusal here (common when a domain
   * restricts sharing) must not fail the export — the link still works for
   * everyone who should have it.
   */
  private async share(spreadsheetId: string): Promise<void> {
    for (const email of this.opts.shareWith) {
      try {
        await this.auth.api(`${DRIVE_API}/${spreadsheetId}/permissions?sendNotificationEmail=false&supportsAllDrives=true`, {
          method: "POST",
          body: { type: "user", role: "writer", emailAddress: email },
        });
      } catch (err) {
        console.warn(`sheet ${spreadsheetId}: could not share with ${email}: ${(err as Error).message}`);
      }
    }
  }
}

/**
 * Wrap long cells, size columns within a sane range (Sheets' own auto-resize
 * has no maximum, so one long sentence stretches its column off-screen), and
 * apply whatever presentation the tab asked for.
 */
function formatRequests(sheetId: number, tab: SheetTab): object[] {
  if (tab.rows.length === 0) return [];
  const columns = Math.max(...tab.rows.map((r) => r.length));
  const widths: object[] = [];
  for (let c = 0; c < columns; c++) {
    const explicit = tab.columnWidths?.[c];
    const longest = Math.max(...tab.rows.map((r) => String(r[c] ?? "").length));
    const pixels = explicit ?? Math.min(MAX_COLUMN_PX, Math.max(MIN_COLUMN_PX, 16 + longest * 7));
    widths.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex: c, endIndex: c + 1 },
        properties: { pixelSize: pixels },
        fields: "pixelSize",
      },
    });
  }

  const base: object[] = [
    {
      repeatCell: {
        range: { sheetId },
        cell: { userEnteredFormat: { wrapStrategy: "WRAP", verticalAlignment: "TOP", textFormat: { fontSize: 10 } } },
        fields: "userEnteredFormat(wrapStrategy,verticalAlignment,textFormat.fontSize)",
      },
    },
    ...widths,
  ];

  if (tab.headerRow !== false) {
    base.unshift(
      { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } },
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: GREY, borders: { bottom: { style: "SOLID", color: LINE } } } },
          fields: "userEnteredFormat(textFormat.bold,backgroundColor,borders.bottom)",
        },
      },
    );
  }

  const styles = tab.styles ?? [];
  // Re-exporting hits a sheet whose cells are already merged, and Sheets
  // rejects overlapping merges — clear them first.
  const unmerge = styles.some((st) => st.kind === "merge") ? [{ unmergeCells: { range: { sheetId } } }] : [];
  return [...unmerge, ...base, ...styles.map((st) => styleRequest(sheetId, st))];
}

const INK = { red: 0.1, green: 0.11, blue: 0.13 };
const WHITE = { red: 1, green: 1, blue: 1 };
const GREY = { red: 0.96, green: 0.96, blue: 0.97 };
const LINE = { red: 0.82, green: 0.84, blue: 0.86 };
const MUTED = { red: 0.42, green: 0.45, blue: 0.5 };
const TONES = {
  good: { fill: { red: 0.9, green: 0.96, blue: 0.91 }, text: { red: 0.1, green: 0.42, blue: 0.18 } },
  warn: { fill: { red: 1, green: 0.96, blue: 0.86 }, text: { red: 0.55, green: 0.37, blue: 0.03 } },
  bad: { fill: { red: 0.99, green: 0.91, blue: 0.9 }, text: { red: 0.65, green: 0.16, blue: 0.12 } },
  muted: { fill: GREY, text: MUTED },
};

function styleRequest(sheetId: number, style: CellStyle): object {
  const row = (r: number, startCol = 0, endCol?: number) => ({ sheetId, startRowIndex: r, endRowIndex: r + 1, startColumnIndex: startCol, ...(endCol === undefined ? {} : { endColumnIndex: endCol }) });
  switch (style.kind) {
    case "title":
      return {
        repeatCell: {
          range: row(style.row, 0, style.span),
          cell: { userEnteredFormat: { backgroundColor: INK, textFormat: { bold: true, fontSize: 13, foregroundColor: WHITE }, verticalAlignment: "MIDDLE", padding: { top: 6, bottom: 6, left: 8 } } },
          fields: "userEnteredFormat(backgroundColor,textFormat,verticalAlignment,padding)",
        },
      };
    case "subtitle":
      return {
        repeatCell: {
          range: row(style.row, 0, style.span),
          cell: { userEnteredFormat: { textFormat: { foregroundColor: MUTED, fontSize: 10 } } },
          fields: "userEnteredFormat.textFormat",
        },
      };
    case "section":
      return {
        repeatCell: {
          range: row(style.row, 0, style.span),
          cell: { userEnteredFormat: { backgroundColor: GREY, textFormat: { bold: true, fontSize: 11 }, borders: { bottom: { style: "SOLID", color: LINE } } } },
          fields: "userEnteredFormat(backgroundColor,textFormat,borders.bottom)",
        },
      };
    case "header":
      return {
        repeatCell: {
          range: row(style.row, 0, style.span),
          cell: { userEnteredFormat: { textFormat: { bold: true, foregroundColor: MUTED }, borders: { bottom: { style: "SOLID", color: LINE } } } },
          fields: "userEnteredFormat(textFormat,borders.bottom)",
        },
      };
    case "label":
      return {
        repeatCell: {
          range: row(style.row, 0, 1),
          cell: { userEnteredFormat: { textFormat: { foregroundColor: MUTED } } },
          fields: "userEnteredFormat.textFormat",
        },
      };
    case "money":
      return {
        repeatCell: {
          range: row(style.row, style.col, style.col + 1),
          cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "#,##0.00" }, horizontalAlignment: "RIGHT" } },
          fields: "userEnteredFormat(numberFormat,horizontalAlignment)",
        },
      };
    case "verdict":
      return {
        repeatCell: {
          range: row(style.row, style.col, style.col + 1),
          cell: { userEnteredFormat: { backgroundColor: TONES[style.tone].fill, textFormat: { foregroundColor: TONES[style.tone].text, bold: style.tone !== "muted" } } },
          fields: "userEnteredFormat(backgroundColor,textFormat)",
        },
      };
    case "link":
      return {
        repeatCell: {
          range: row(style.row, style.col, style.col + 1),
          cell: { userEnteredFormat: { textFormat: { link: { uri: style.uri }, foregroundColor: { red: 0.1, green: 0.34, blue: 0.77 }, underline: true } } },
          fields: "userEnteredFormat.textFormat",
        },
      };
    case "merge":
      return { mergeCells: { range: { sheetId, startRowIndex: style.row, endRowIndex: style.row + 1, startColumnIndex: style.startCol, endColumnIndex: style.endCol }, mergeType: "MERGE_ALL" } };
    case "note":
      return {
        repeatCell: {
          range: row(style.row, 0, style.span),
          cell: { userEnteredFormat: { textFormat: { italic: true, fontSize: 9, foregroundColor: MUTED } } },
          fields: "userEnteredFormat.textFormat",
        },
      };
  }
}

const MIN_COLUMN_PX = 70;
const MAX_COLUMN_PX = 420;

function cell(v: unknown): string | number | boolean {
  return v === null || v === undefined ? "" : (v as string | number | boolean);
}

/** Single quotes are the escape in an A1 range that's already quoted. */
function escapeTitle(title: string): string {
  return title.replace(/'/g, "''");
}
