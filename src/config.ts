import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  STAFF_API_TOKEN: z.string().min(1),

  DATABASE_URL: z.string().min(1),

  OBJECT_STORE_DRIVER: z.enum(["LOCAL", "S3"]).default("LOCAL"),
  OBJECT_STORE_LOCAL_PATH: z.string().default("./data/objects"),
  OBJECT_STORE_S3_BUCKET: z.string().optional(),
  OBJECT_STORE_S3_REGION: z.string().default("auto"),
  OBJECT_STORE_S3_ENDPOINT: z.string().optional(),
  OBJECT_STORE_S3_ACCESS_KEY_ID: z.string().optional(),
  OBJECT_STORE_S3_SECRET_ACCESS_KEY: z.string().optional(),
  OBJECT_STORE_S3_FORCE_PATH_STYLE: z.coerce.boolean().default(true),

  DROPBOX_MODE: z.enum(["fake", "real"]).default("fake"),
  DROPBOX_APP_KEY: z.string().optional(),
  DROPBOX_APP_SECRET: z.string().optional(),
  DROPBOX_ACCESS_TOKEN: z.string().optional(),
  DROPBOX_INTAKE_ROOT: z.string().default("/betlab-intake"),
  DROPBOX_POLL_INTERVAL_MS: z.coerce.number().default(60000),
  // PRD §12 risk: "Dropbox quota fills, uploads silently rejected".
  DROPBOX_QUOTA_WARNING_THRESHOLD: z.coerce.number().min(0).max(1).default(0.9),
  DROPBOX_QUOTA_CHECK_INTERVAL_MS: z.coerce.number().default(6 * 60 * 60 * 1000),

  INBOUND_EMAIL_TOKEN: z.string().optional(),

  EMAIL_MODE: z.enum(["fake", "smtp"]).default("fake"),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_SECURE: z.coerce.boolean().default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default("intake@betlab.example"),

  VISION_MODE: z.enum(["fake", "claude"]).default("fake"),
  ANTHROPIC_API_KEY: z.string().optional(),
  // Sonnet 5 by default: the pipeline reads each row exactly once off a
  // stitched panorama, so the per-video cost is driven by row count, not
  // frames — a few cents even on Sonnet — and read accuracy is what the
  // whole system hinges on. See docs/extraction-benchmark.md for how to
  // evaluate a cheaper/optimized model against this one.
  CLAUDE_VISION_MODEL: z.string().default("claude-sonnet-5"),
  // Independent second read of every tile, compared field by field against
  // the primary — the only check timestamps and descriptions get. "off"
  // disables it. Roughly +25% cost at Haiku prices.
  CROSSCHECK_VISION_MODEL: z.string().default("claude-haiku-4-5"),

  // Spreadsheet export (one workbook per enrollment, a tab per recording).
  // fake = CSV tabs in the object store, served from /sheets/:id — the whole
  // flow works with no Google credentials.
  SHEETS_MODE: z.enum(["fake", "google"]).default("fake"),
  /** Path to the service-account JSON key, or the JSON itself. */
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  /** Comma-separated emails each created workbook is shared with — without one, nobody can open it. */
  SHEETS_SHARE_WITH: z.string().default(""),
  SHEETS_DRIVE_FOLDER_ID: z.string().optional(),
  /** Used to build links in exports and in the fake exporter's URLs. */
  PUBLIC_BASE_URL: z.string().default("http://localhost:3000"),

  EXTRACTOR_VERSION: z.string().default("v1"),
  // Decode rate for scroll reconstruction. Denser sampling keeps consecutive
  // frames overlapping through fast flicks; cost is local CPU only.
  PANORAMA_FPS: z.coerce.number().default(10),
  AUTO_EXTRACT_ON_INGEST: z.coerce.boolean().default(true),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
  }
  if (parsed.data.OBJECT_STORE_DRIVER === "S3" && !parsed.data.OBJECT_STORE_S3_BUCKET) {
    throw new Error("OBJECT_STORE_S3_BUCKET is required when OBJECT_STORE_DRIVER=S3");
  }
  if (parsed.data.DROPBOX_MODE === "real" && !parsed.data.DROPBOX_ACCESS_TOKEN) {
    throw new Error("DROPBOX_ACCESS_TOKEN is required when DROPBOX_MODE=real");
  }
  if (parsed.data.EMAIL_MODE === "smtp" && !parsed.data.SMTP_HOST) {
    throw new Error("SMTP_HOST is required when EMAIL_MODE=smtp");
  }
  if (parsed.data.VISION_MODE === "claude" && !parsed.data.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is required when VISION_MODE=claude");
  }
  if (parsed.data.SHEETS_MODE === "google") {
    if (!parsed.data.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is required when SHEETS_MODE=google");
    if (!parsed.data.SHEETS_SHARE_WITH.trim()) {
      throw new Error("SHEETS_SHARE_WITH is required when SHEETS_MODE=google — a workbook a service account owns is invisible until it's shared with someone");
    }
  }
  return parsed.data;
}
