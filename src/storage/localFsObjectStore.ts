import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ObjectStore } from "./objectStore.js";

/** Local-filesystem backed ObjectStore, for dev and until a hosting vendor is picked (PRD D2). */
export class LocalFsObjectStore implements ObjectStore {
  constructor(private readonly rootDir: string) {}

  private pathFor(key: string): string {
    // Shard by the first 2 hex chars to avoid one giant flat directory.
    return join(this.rootDir, key.slice(0, 2), key);
  }

  async put(key: string, data: Buffer): Promise<void> {
    const path = this.pathFor(key);
    if (existsSync(path)) return;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async exists(key: string): Promise<boolean> {
    return existsSync(this.pathFor(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}
