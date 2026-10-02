import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { GoogleSheetsExporter } from "../src/sheets/googleSheetsExporter.js";
import { parseServiceAccountKey } from "../src/sheets/googleAuth.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const serviceAccount = { client_email: "betlab@example.iam.gserviceaccount.com", private_key: privateKey };

interface Call { url: string; method: string; body: any }

function mockGoogle(handlers: Array<(c: Call) => unknown | undefined>) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit = {}) => {
    const call: Call = { url: String(url), method: init.method ?? "GET", body: init.body ? (typeof init.body === "string" ? JSON.parse(init.body) : init.body) : undefined };
    calls.push(call);
    if (call.url.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    }
    for (const h of handlers) {
      const res = h(call);
      if (res !== undefined) return new Response(JSON.stringify(res), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });
  return calls;
}

describe("GoogleSheetsExporter", () => {
  afterEach(() => vi.unstubAllGlobals());

  const workbook = { title: "Betlab — p1 — Acme", tabs: [{ title: "Summary", rows: [["a", "b"], [1, 2]] }, { title: "1. rec", rows: [["#"], [0]] }] };

  it("creates the workbook, shares it, and returns per-tab deep links", async () => {
    const calls = mockGoogle([
      (c) => (c.method === "POST" && c.url.endsWith("/v4/spreadsheets")
        ? { spreadsheetId: "SS1", spreadsheetUrl: "https://docs.google.com/spreadsheets/d/SS1/edit", sheets: [{ properties: { sheetId: 0, title: "Summary" } }, { properties: { sheetId: 7, title: "1. rec" } }] }
        : undefined),
    ]);
    const exporter = new GoogleSheetsExporter({ serviceAccount: parseServiceAccountKey(JSON.stringify(serviceAccount)), shareWith: ["ops@betlab.example"] });
    const out = await exporter.export(workbook, null);

    expect(out.documentId).toBe("SS1");
    expect(out.tabs.find((t) => t.title === "1. rec")!.url).toBe("https://docs.google.com/spreadsheets/d/SS1/edit#gid=7");

    // Values are cleared before writing so a shorter export leaves nothing behind.
    const order = calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
    expect(order.indexOf("POST /v4/spreadsheets/SS1/values:batchClear")).toBeLessThan(order.indexOf("POST /v4/spreadsheets/SS1/values:batchUpdate"));

    const share = calls.find((c) => c.url.includes("/permissions"));
    expect(share!.body).toMatchObject({ type: "user", role: "writer", emailAddress: "ops@betlab.example" });

    const write = calls.find((c) => c.url.endsWith("values:batchUpdate"))!;
    expect(write.body.data[0].range).toBe("'Summary'!A1");
    expect(write.body.data[0].values).toEqual([["a", "b"], [1, 2]]);
  });

  it("re-uses an existing workbook, adds only missing tabs, and does not re-share", async () => {
    const calls = mockGoogle([
      (c) => (c.method === "GET" && c.url.includes("/v4/spreadsheets/SS1")
        ? { spreadsheetId: "SS1", spreadsheetUrl: "https://docs.google.com/spreadsheets/d/SS1/edit", sheets: [{ properties: { sheetId: 0, title: "Summary" } }] }
        : undefined),
      (c) => (c.url.endsWith("SS1:batchUpdate") && c.body?.requests?.[0]?.addSheet
        ? { replies: [{ addSheet: { properties: { sheetId: 9, title: "1. rec" } } }] }
        : undefined),
    ]);
    const exporter = new GoogleSheetsExporter({ serviceAccount: parseServiceAccountKey(JSON.stringify(serviceAccount)), shareWith: ["ops@betlab.example"] });
    const out = await exporter.export(workbook, "SS1");

    expect(out.documentId).toBe("SS1");
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/v4/spreadsheets"))).toBe(false);
    expect(calls.some((c) => c.url.includes("/permissions"))).toBe(false);
    const add = calls.find((c) => c.body?.requests?.[0]?.addSheet)!;
    expect(add.body.requests).toHaveLength(1);
    expect(add.body.requests[0].addSheet.properties.title).toBe("1. rec");
  });

  it("starts a new workbook when the stored one was deleted in Drive", async () => {
    vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit = {}) => {
      const u = String(url);
      if (u.includes("oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      if ((init.method ?? "GET") === "GET" && u.includes("/v4/spreadsheets/GONE")) {
        return new Response(JSON.stringify({ error: { message: "File not found: GONE." } }), { status: 404 });
      }
      if ((init.method ?? "GET") === "POST" && u.endsWith("/v4/spreadsheets")) {
        return new Response(JSON.stringify({ spreadsheetId: "SS2", spreadsheetUrl: "https://docs.google.com/spreadsheets/d/SS2/edit", sheets: [{ properties: { sheetId: 0, title: "Summary" } }, { properties: { sheetId: 1, title: "1. rec" } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    const exporter = new GoogleSheetsExporter({ serviceAccount: parseServiceAccountKey(JSON.stringify(serviceAccount)), shareWith: [] });
    expect((await exporter.export(workbook, "GONE")).documentId).toBe("SS2");
  });

  it("surfaces a Google error with its message instead of a bare status", async () => {
    vi.stubGlobal("fetch", async (url: string | URL) =>
      String(url).includes("oauth2.googleapis.com/token")
        ? new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 })
        : new Response(JSON.stringify({ error: { message: "Google Sheets API has not been used in project 123 before or it is disabled." } }), { status: 403 }),
    );
    const exporter = new GoogleSheetsExporter({ serviceAccount: parseServiceAccountKey(JSON.stringify(serviceAccount)), shareWith: [] });
    await expect(exporter.export(workbook, null)).rejects.toThrow(/has not been used in project/);
  });

  it("rejects a key file that isn't a service account key", () => {
    expect(() => parseServiceAccountKey(JSON.stringify({ installed: { client_id: "x" } }))).toThrow(/client_email/);
  });

  it("creates inside a Shared Drive via Drive (a service account has no storage of its own)", async () => {
    const calls = mockGoogle([
      (c) => (c.method === "POST" && c.url.startsWith("https://www.googleapis.com/drive/v3/files?") ? { id: "FILE1" } : undefined),
      (c) => (c.method === "GET" && c.url.includes("/v4/spreadsheets/FILE1")
        ? { spreadsheetId: "FILE1", spreadsheetUrl: "https://docs.google.com/spreadsheets/d/FILE1/edit", sheets: [{ properties: { sheetId: 0, title: "Sheet1" } }] }
        : undefined),
      (c) => (c.url.endsWith("FILE1:batchUpdate") && c.body?.requests?.[0]?.addSheet
        ? { replies: [{ addSheet: { properties: { sheetId: 11, title: "Summary" } } }, { addSheet: { properties: { sheetId: 12, title: "1. rec" } } }] }
        : undefined),
    ]);
    const exporter = new GoogleSheetsExporter({ serviceAccount: parseServiceAccountKey(JSON.stringify(serviceAccount)), shareWith: [], folderId: "DRIVE_FOLDER" });
    const out = await exporter.export(workbook, null);

    expect(out.documentId).toBe("FILE1");
    const create = calls.find((c) => c.method === "POST" && c.url.includes("/drive/v3/files?"))!;
    expect(create.url).toContain("supportsAllDrives=true");
    expect(create.body).toMatchObject({ mimeType: "application/vnd.google-apps.spreadsheet", parents: ["DRIVE_FOLDER"] });
    // The default "Sheet1" is removed, our tabs added.
    const batch = calls.find((c) => c.body?.requests?.[0]?.addSheet)!;
    expect(batch.body.requests.at(-1)).toEqual({ deleteSheet: { sheetId: 0 } });
    expect(out.tabs.map((t) => t.url)).toEqual([
      "https://docs.google.com/spreadsheets/d/FILE1/edit#gid=11",
      "https://docs.google.com/spreadsheets/d/FILE1/edit#gid=12",
    ]);
  });

  it("explains the storage-quota trap when creating without a Shared Drive is refused", async () => {
    vi.stubGlobal("fetch", async (url: string | URL) =>
      String(url).includes("oauth2.googleapis.com/token")
        ? new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 })
        : new Response(JSON.stringify({ error: { code: 403, message: "The caller does not have permission" } }), { status: 403 }),
    );
    const exporter = new GoogleSheetsExporter({ serviceAccount: parseServiceAccountKey(JSON.stringify(serviceAccount)), shareWith: [] });
    await expect(exporter.export(workbook, null)).rejects.toThrow(/no Drive storage of its own.*SHEETS_DRIVE_FOLDER_ID/s);
  });

  it("does not fail the export when a domain policy refuses the share", async () => {
    mockGoogle([
      (c) => (c.method === "POST" && c.url.startsWith("https://www.googleapis.com/drive/v3/files?") ? { id: "FILE2" } : undefined),
      (c) => (c.method === "GET" && c.url.includes("/v4/spreadsheets/FILE2")
        ? { spreadsheetId: "FILE2", spreadsheetUrl: "https://docs.google.com/spreadsheets/d/FILE2/edit", sheets: [] }
        : undefined),
      (c) => (c.url.endsWith("FILE2:batchUpdate") && c.body?.requests?.[0]?.addSheet
        ? { replies: [{ addSheet: { properties: { sheetId: 1, title: "Summary" } } }, { addSheet: { properties: { sheetId: 2, title: "1. rec" } } }] }
        : undefined),
      (c) => {
        if (c.url.includes("/permissions")) throw new Error("sharing refused");
        return undefined;
      },
    ]);
    const exporter = new GoogleSheetsExporter({ serviceAccount: parseServiceAccountKey(JSON.stringify(serviceAccount)), shareWith: ["ops@betlab.example"], folderId: "DRIVE_FOLDER" });
    await expect(exporter.export(workbook, null)).resolves.toMatchObject({ documentId: "FILE2" });
  });

  it("turns a tab's style vocabulary into Sheets formatting requests", async () => {
    const styled = {
      title: "W",
      tabs: [
        {
          title: "Summary",
          headerRow: false,
          columnWidths: [190, 200],
          rows: [["Betlab — wager evidence"], ["Total wagered", 174.2], ["Balance chain", "1 break(s)"], ["link", "http://x/y"]],
          styles: [
            { kind: "title", row: 0, span: 7 },
            { kind: "money", row: 1, col: 1 },
            { kind: "verdict", row: 2, col: 1, tone: "bad" },
            { kind: "link", row: 3, col: 1, uri: "http://x/y" },
          ],
        },
      ],
    } as const;
    const calls = mockGoogle([
      (c) => (c.method === "POST" && c.url.endsWith("/v4/spreadsheets")
        ? { spreadsheetId: "S", spreadsheetUrl: "https://docs.google.com/spreadsheets/d/S/edit", sheets: [{ properties: { sheetId: 3, title: "Summary" } }] }
        : undefined),
    ]);
    const exporter = new GoogleSheetsExporter({ serviceAccount: parseServiceAccountKey(JSON.stringify(serviceAccount)), shareWith: [] });
    await exporter.export(styled as any, null);

    const format = calls.filter((c) => c.url.endsWith("S:batchUpdate")).flatMap((c) => c.body.requests);
    const cells = format.filter((r: any) => r.repeatCell).map((r: any) => r.repeatCell);
    // headerRow:false ⇒ no frozen row, no bolded first row
    expect(format.some((r: any) => r.updateSheetProperties?.properties?.gridProperties?.frozenRowCount)).toBe(false);
    expect(cells.find((c: any) => c.range.startRowIndex === 0)!.cell.userEnteredFormat.textFormat.bold).toBe(true);
    expect(cells.find((c: any) => c.range.startRowIndex === 1)!.cell.userEnteredFormat.numberFormat.pattern).toBe("#,##0.00");
    expect(cells.find((c: any) => c.range.startRowIndex === 2)!.cell.userEnteredFormat.backgroundColor).toBeDefined();
    expect(cells.find((c: any) => c.range.startRowIndex === 3)!.cell.userEnteredFormat.textFormat.link).toEqual({ uri: "http://x/y" });
    // Explicit widths win over content-derived ones.
    const widths = format.filter((r: any) => r.updateDimensionProperties).map((r: any) => r.updateDimensionProperties.properties.pixelSize);
    expect(widths.slice(0, 2)).toEqual([190, 200]);
  });
});
