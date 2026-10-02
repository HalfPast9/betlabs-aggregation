import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.js";
import { requireStaffAuth } from "../lib/auth.js";
import { buildEnrollmentWorkbook } from "../sheets/enrollmentWorkbook.js";
import { readFakeSheet, type FakeSheetIndex } from "../sheets/fakeSheetsExporter.js";

export async function registerSheetRoutes(app: FastifyInstance, opts: { deps: AppDeps }) {
  const { deps } = opts;

  // The fake exporter's viewer: a plain index of the CSV tabs it wrote. Not
  // behind staff auth for the same reason a Google Sheets link isn't — the
  // link is the capability, and the ids are unguessable.
  app.get<{ Params: { documentId: string } }>("/sheets/:documentId", async (request, reply) => {
    const index = await readFakeSheet(deps.objectStore, request.params.documentId);
    if (!index) {
      reply.code(404).send({ error: "no such sheet" });
      return;
    }
    reply.type("text/html").send(renderIndex(request.params.documentId, index));
  });

  app.get<{ Params: { documentId: string; slug: string } }>("/sheets/:documentId/:slug.csv", async (request, reply) => {
    try {
      const csv = await deps.objectStore.get(`sheets/${request.params.documentId}/${request.params.slug}.csv`);
      reply.type("text/csv; charset=utf-8").header("content-disposition", `attachment; filename="${request.params.slug}.csv"`).send(csv);
    } catch {
      reply.code(404).send({ error: "no such tab" });
    }
  });

  // The tab itself, rendered — so the credential-free mode is something you
  // can actually read, not just a file that downloads.
  app.get<{ Params: { documentId: string; slug: string } }>("/sheets/:documentId/:slug", async (request, reply) => {
    const { documentId, slug } = request.params;
    const index = await readFakeSheet(deps.objectStore, documentId);
    const tab = index?.tabs.find((t) => t.slug === slug);
    if (!index || !tab) {
      reply.code(404).send({ error: "no such tab" });
      return;
    }
    const csv = (await deps.objectStore.get(`sheets/${documentId}/${slug}.csv`)).toString("utf8");
    reply.type("text/html").send(renderTab(documentId, index, tab.title, parseCsv(csv)));
  });

  app.register(async (secured) => {
    secured.addHook("preHandler", requireStaffAuth(deps.prisma));

    // One workbook per enrollment, a tab per recording. Re-exporting refreshes
    // the same workbook, so the link in the console stays valid.
    secured.post<{ Params: { id: string }; Querystring: { submissionId?: string } }>("/enrollments/:id/sheet", async (request, reply) => {
      const enrollment = await deps.prisma.enrollment.findUnique({ where: { id: request.params.id } });
      if (!enrollment) {
        reply.code(404).send({ error: "enrollment not found" });
        return;
      }
      try {
        const { workbook, tabBySubmission } = await buildEnrollmentWorkbook(deps.prisma, enrollment.id, deps.publicBaseUrl);
        const exported = await deps.sheetsExporter.export(workbook, enrollment.sheetDocumentId);
        await deps.prisma.enrollment.update({
          where: { id: enrollment.id },
          data: { sheetDocumentId: exported.documentId, sheetUrl: exported.url },
        });
        await deps.prisma.auditEvent.create({
          data: { actor: request.staffUser?.name ?? "unknown-staff", action: "export_sheet", target: enrollment.id },
        });

        // A submission page asks for its own tab so the link opens there.
        const wanted = request.query.submissionId ? tabBySubmission.get(request.query.submissionId) : undefined;
        const tab = wanted ? exported.tabs.find((t) => t.title === wanted) : undefined;
        reply.send({ url: tab?.url ?? exported.url, workbookUrl: exported.url, documentId: exported.documentId, mode: deps.sheetsExporter.kind, tabs: exported.tabs });
      } catch (err) {
        reply.code(502).send({ error: `sheet export failed: ${(err as Error).message}` });
      }
    });
  });
}

/** Minimal RFC4180 reader — the counterpart of toCsv in fakeSheetsExporter. */
export function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i]!;
    if (quoted) {
      if (c === '"') {
        if (csv[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (c !== "\r") cell += c;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function renderTab(documentId: string, index: FakeSheetIndex, title: string, rows: string[][]): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const nav = index.tabs
    .map((t) => (t.title === title ? `<b>${esc(t.title)}</b>` : `<a href="/sheets/${esc(documentId)}/${esc(t.slug)}">${esc(t.title)}</a>`))
    .join(" · ");
  const body = rows
    .map((r, i) => `<tr>${r.map((c) => (i === 0 ? `<th>${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join("")}</tr>`)
    .join("");
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)} — ${esc(index.title)}</title>
<style>body{font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;margin:32px;color:#1b1b1b}
h1{font-size:17px;margin:0 0 2px}nav{color:#666;margin:0 0 16px}nav a{color:#1a56c4}
table{border-collapse:collapse}th,td{border:1px solid #dcdcdc;padding:4px 8px;text-align:left;white-space:pre-wrap;vertical-align:top}
th{background:#f4f6f8;position:sticky;top:0}tr:nth-child(even) td{background:#fafafa}
.dl{float:right;font-size:12px}</style>
<a class="dl" href="/sheets/${esc(documentId)}/${esc(slugOf(index, title))}.csv">Download CSV</a>
<h1>${esc(index.title)}</h1><nav>${nav}</nav><table>${body}</table>`;
}

function slugOf(index: FakeSheetIndex, title: string): string {
  return index.tabs.find((t) => t.title === title)?.slug ?? "";
}

function renderIndex(documentId: string, index: FakeSheetIndex): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const tabs = index.tabs
    .map((t) => `<li id="${esc(t.slug)}"><a href="/sheets/${esc(documentId)}/${esc(t.slug)}">${esc(t.title)}</a> <a class="csv" href="/sheets/${esc(documentId)}/${esc(t.slug)}.csv">csv</a></li>`)
    .join("");
  return `<!doctype html><meta charset="utf-8"><title>${esc(index.title)}</title>
<style>body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;max-width:720px;margin:48px auto;padding:0 16px;color:#1b1b1b}
h1{font-size:18px;margin:0 0 4px}p{color:#666}li{margin:4px 0}code{background:#f2f2f2;padding:1px 5px;border-radius:4px}
.csv{font-size:11px;color:#888;margin-left:6px}</style>
<h1>${esc(index.title)}</h1>
<p>Spreadsheet export in <code>SHEETS_MODE=fake</code> — one CSV per tab. Set <code>SHEETS_MODE=google</code> with a service-account key and these become a real Google Sheet.</p>
<ul>${tabs}</ul>`;
}
