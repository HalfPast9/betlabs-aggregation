import type { Config } from "../config.js";
import type { DropboxClient } from "./types.js";
import { FakeDropboxClient } from "./fakeClient.js";
import { RealDropboxClient } from "./realClient.js";

export type { DropboxClient } from "./types.js";

export function createDropboxClient(config: Config): DropboxClient {
  if (config.DROPBOX_MODE === "real") {
    return new RealDropboxClient({
      accessToken: config.DROPBOX_ACCESS_TOKEN!,
      appSecret: config.DROPBOX_APP_SECRET,
    });
  }
  return new FakeDropboxClient();
}
