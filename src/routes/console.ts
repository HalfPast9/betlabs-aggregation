import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const consoleDir = join(dirname(fileURLToPath(import.meta.url)), "..", "console");

/**
 * PRD §6.4 — the thin review console. A single static HTML page (no build
 * step); it authenticates by having the staff member paste their token,
 * then talks to the JSON API directly from the browser.
 */
export async function registerConsoleRoutes(app: FastifyInstance) {
  const html = await readFile(join(consoleDir, "index.html"), "utf8");

  app.get("/console", async (_request, reply) => {
    reply.type("text/html").send(html);
  });
  app.get("/", async (_request, reply) => {
    reply.redirect("/console");
  });
}
