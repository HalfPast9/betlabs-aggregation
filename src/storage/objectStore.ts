import type { Config } from "../config.js";
import { LocalFsObjectStore } from "./localFsObjectStore.js";
import { S3ObjectStore } from "./s3ObjectStore.js";

/**
 * Content-addressed, write-once object store. Raw media is keyed by its sha256
 * content hash (PRD §6.2 — "written once, never mutated, keyed by content hash").
 */
export interface ObjectStore {
  /** Writes bytes under `key` if not already present; idempotent. */
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
}

export function createObjectStore(config: Config): ObjectStore {
  if (config.OBJECT_STORE_DRIVER === "S3") {
    return new S3ObjectStore({
      bucket: config.OBJECT_STORE_S3_BUCKET!,
      region: config.OBJECT_STORE_S3_REGION,
      endpoint: config.OBJECT_STORE_S3_ENDPOINT,
      accessKeyId: config.OBJECT_STORE_S3_ACCESS_KEY_ID,
      secretAccessKey: config.OBJECT_STORE_S3_SECRET_ACCESS_KEY,
      forcePathStyle: config.OBJECT_STORE_S3_FORCE_PATH_STYLE,
    });
  }
  return new LocalFsObjectStore(config.OBJECT_STORE_LOCAL_PATH);
}
