import { describe, expect, it } from "vitest";
import { createTmpObjectStore } from "./helpers/tmpObjectStore.js";

describe("LocalFsObjectStore", () => {
  it("round-trips content by key and reports existence", async () => {
    const { store, cleanup } = await createTmpObjectStore();
    try {
      const key = "deadbeef";
      const data = Buffer.from("hello evidence");

      expect(await store.exists(key)).toBe(false);
      await store.put(key, data);
      expect(await store.exists(key)).toBe(true);
      await expect(store.get(key)).resolves.toEqual(data);
    } finally {
      await cleanup();
    }
  });

  it("is idempotent — a second put with the same key does not error or change content", async () => {
    const { store, cleanup } = await createTmpObjectStore();
    try {
      const key = "cafef00d";
      await store.put(key, Buffer.from("original"));
      await store.put(key, Buffer.from("different-bytes-same-key"));
      await expect(store.get(key)).resolves.toEqual(Buffer.from("original"));
    } finally {
      await cleanup();
    }
  });

  it("is write-once by default but replaces when a derived artifact asks to overwrite", async () => {
    const { store, cleanup } = await createTmpObjectStore();
    try {
      await store.put("sheets/doc/index.json", Buffer.from("first"));
      await store.put("sheets/doc/index.json", Buffer.from("second"));
      expect((await store.get("sheets/doc/index.json")).toString()).toBe("first");

      await store.put("sheets/doc/index.json", Buffer.from("second"), { overwrite: true });
      expect((await store.get("sheets/doc/index.json")).toString()).toBe("second");
    } finally {
      await cleanup();
    }
  });
});
