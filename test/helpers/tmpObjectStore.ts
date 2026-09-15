import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFsObjectStore } from "../../src/storage/localFsObjectStore.js";

export async function createTmpObjectStore() {
  const dir = await mkdtemp(join(tmpdir(), "betlab-objects-"));
  const store = new LocalFsObjectStore(dir);
  return { store, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
