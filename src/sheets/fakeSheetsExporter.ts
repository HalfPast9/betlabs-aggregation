import type { ObjectStore } from "../storage/objectStore.js";
import type { CellValue, ExportedWorkbook, SheetsExporter, Workbook } from "./exporter.js";

/**
 * Writes each tab as a CSV into the object store and serves them from
 * `/sheets/:documentId` — so the whole export flow (button, link, contents)
 * works with no Google credentials at all, the same way DROPBOX_MODE=fake
 * and VISION_MODE=fake do. Swap SHEETS_MODE=google for the real thing.
 */
export class FakeSheetsExporter implements SheetsExporter {
  readonly kind = "fake" as const;

  constructor(
    private readonly objectStore: ObjectStore,
    /** Base the returned links are built from, e.g. http://localhost:3000. */
    private readonly baseUrl: string,
  ) {}

  async export(workbook: Workbook, documentId: string | null): Promise<ExportedWorkbook> {
    const id = documentId ?? `sheet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const existing = await readIndex(this.objectStore, id);
    const tabs = new Map(existing.map((t) => [t.title, t]));

    for (const tab of workbook.tabs) {
      const slug = slugify(tab.title);
      await this.objectStore.put(`sheets/${id}/${slug}.csv`, Buffer.from(toCsv(tab.rows), "utf8"), { overwrite: true });
      tabs.set(tab.title, { title: tab.title, slug });
    }
    const index = { title: workbook.title, tabs: [...tabs.values()] };
    await this.objectStore.put(`sheets/${id}/index.json`, Buffer.from(JSON.stringify(index), "utf8"), { overwrite: true });

    return {
      url: `${this.baseUrl}/sheets/${id}`,
      documentId: id,
      tabs: workbook.tabs.map((t) => ({ title: t.title, url: `${this.baseUrl}/sheets/${id}#${slugify(t.title)}` })),
    };
  }
}

export interface FakeSheetIndex {
  title: string;
  tabs: Array<{ title: string; slug: string }>;
}

export async function readFakeSheet(objectStore: ObjectStore, documentId: string): Promise<FakeSheetIndex | null> {
  try {
    return JSON.parse((await objectStore.get(`sheets/${documentId}/index.json`)).toString("utf8")) as FakeSheetIndex;
  } catch {
    return null;
  }
}

async function readIndex(objectStore: ObjectStore, id: string): Promise<FakeSheetIndex["tabs"]> {
  return (await readFakeSheet(objectStore, id))?.tabs ?? [];
}

export function toCsv(rows: CellValue[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}

function csvCell(v: CellValue): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "tab";
}
