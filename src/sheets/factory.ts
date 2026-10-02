import { readFileSync } from "node:fs";
import type { Config } from "../config.js";
import type { ObjectStore } from "../storage/objectStore.js";
import type { SheetsExporter } from "./exporter.js";
import { FakeSheetsExporter } from "./fakeSheetsExporter.js";
import { GoogleSheetsExporter } from "./googleSheetsExporter.js";
import { parseServiceAccountKey } from "./googleAuth.js";

export function createSheetsExporter(config: Config, objectStore: ObjectStore): SheetsExporter {
  if (config.SHEETS_MODE === "google") {
    const raw = config.GOOGLE_SERVICE_ACCOUNT_JSON!.trim();
    // Either a path to the key file Google downloads, or the JSON itself.
    const json = raw.startsWith("{") ? raw : readFileSync(raw, "utf8");
    return new GoogleSheetsExporter({
      serviceAccount: parseServiceAccountKey(json),
      shareWith: config.SHEETS_SHARE_WITH.split(",").map((e) => e.trim()).filter(Boolean),
      folderId: config.SHEETS_DRIVE_FOLDER_ID,
    });
  }
  return new FakeSheetsExporter(objectStore, config.PUBLIC_BASE_URL);
}
