import type { Config } from "../config.js";
import { LocalFsObjectStore } from "./localFsObjectStore.js";
import { S3ObjectStore } from "./s3ObjectStore.js";

/**
 * Content-addressed, write-once object store. Raw media is keyed by its sha256
 * content hash (PRD §6.2 — "written once, never mutated, keyed by content hash").
 */
export interface PutOptions {
  /**
   * Replace an existing object. Only for *derived* artifacts the system
   * regenerates (an enrollment's spreadsheet export): raw evidence is keyed
   * by content hash and must stay write-once.
   */
  overwrite?: boolean;
}

export interface ObjectStore {
  /** Writes bytes under `key` if not already present; idempotent unless `overwrite`. */
  put(key: string, data: Buffer, opts?: PutOptions): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  /** Used only by the retention job (PRD §9) — everywhere else, media is write-once. */
  delete(key: string): Promise<void>;
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
