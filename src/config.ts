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
  return parsed.data;
}
