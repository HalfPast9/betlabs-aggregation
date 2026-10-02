export type CellValue = string | number | boolean | null;

/**
 * The small vocabulary of presentation a tab can ask for. Deliberately
 * semantic ("this row is a section heading") rather than visual, so the
 * Google exporter owns what that looks like and the CSV exporter can ignore
 * it entirely.
 */
export type CellStyle =
  | { kind: "title"; row: number; span: number }
  | { kind: "subtitle"; row: number; span: number }
  | { kind: "section"; row: number; span: number }
  | { kind: "header"; row: number; span: number }
  | { kind: "label"; row: number }
  | { kind: "money"; row: number; col: number }
  | { kind: "verdict"; row: number; col: number; tone: "good" | "warn" | "bad" | "muted" }
  | { kind: "link"; row: number; col: number; uri: string }
  | { kind: "note"; row: number; span: number }
  /** Join cells so a long value has the width to be read. */
  | { kind: "merge"; row: number; startCol: number; endCol: number };

export interface SheetTab {
  title: string;
  rows: CellValue[][];
  /** Freeze and bold the first row — right for a data table, wrong for a composed summary. */
  headerRow?: boolean;
  /** Explicit column widths in px; otherwise sized from content. */
  columnWidths?: number[];
  styles?: CellStyle[];
}

export interface Workbook {
  title: string;
  tabs: SheetTab[];
}

export interface ExportedWorkbook {
  url: string;
  /** Stable id so the next export updates this workbook instead of making another. */
  documentId: string;
  /** Per-tab deep-link fragment, so a page can open the workbook at its own tab. */
  tabs: Array<{ title: string; url: string }>;
}

/**
 * Publishes a workbook somewhere a human can open it (PRD §6.4 review, and
 * what Betlab actually works in day to day). Same fake/real pattern as
 * DropboxClient and the vision extractor: the fake writes CSVs to the object
 * store so the whole flow runs with no credentials, and the real one writes
 * to Google Sheets — one env var apart.
 */
export interface SheetsExporter {
  readonly kind: "fake" | "google";
  /**
   * Create the workbook, or rewrite the one `documentId` names. Tabs not in
   * `workbook` are left alone, so an enrollment's sheet accumulates a tab per
   * recording across separate exports.
   */
  export(workbook: Workbook, documentId: string | null): Promise<ExportedWorkbook>;
}
