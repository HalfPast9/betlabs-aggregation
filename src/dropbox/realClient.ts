import { Dropbox } from "dropbox";
import type {
  CreateFileRequestResult,
  DropboxClient,
  DropboxFileEntry,
  ListFolderPage,
} from "./types.js";

export interface RealDropboxClientOptions {
  accessToken: string;
  /** Reserved for webhook signature verification (see webhook.ts); not used by the SDK calls here. */
  appSecret?: string;
}

/**
 * Thin wrapper around the official `dropbox` SDK, narrowed to the DropboxClient
 * interface. Not yet exercised against a real account — PRD D7 (Betlab-owned
 * Dropbox app/business account) is still open. Wire this up by setting
 * DROPBOX_MODE=real plus the DROPBOX_* credentials once that's provisioned.
 */
export class RealDropboxClient implements DropboxClient {
  private readonly dbx: Dropbox;

  constructor(opts: RealDropboxClientOptions) {
    this.dbx = new Dropbox({ accessToken: opts.accessToken });
  }

  async createFileRequest(destinationPath: string, title: string): Promise<CreateFileRequestResult> {
    const res = await this.dbx.fileRequestsCreate({ title, destination: destinationPath });
    return { id: res.result.id, url: res.result.url };
  }

  async listFolder(folderPath: string, cursor?: string): Promise<ListFolderPage> {
    const res = cursor
      ? await this.dbx.filesListFolderContinue({ cursor })
      : await this.dbx.filesListFolder({ path: folderPath, recursive: true });

    const entries: DropboxFileEntry[] = res.result.entries
      .filter((e): e is Extract<typeof e, { ".tag": "file" }> => e[".tag"] === "file")
      .map((e) => ({
        pathLower: e.path_lower ?? e.name.toLowerCase(),
        name: e.name,
        isFile: true,
      }));

    return { entries, cursor: res.result.cursor, hasMore: res.result.has_more };
  }

  async download(pathLower: string): Promise<Buffer> {
    const res = await this.dbx.filesDownload({ path: pathLower });
    const binary = (res.result as unknown as { fileBinary: Uint8Array }).fileBinary;
    return Buffer.from(binary);
  }

  async deleteFile(pathLower: string): Promise<void> {
    await this.dbx.filesDeleteV2({ path: pathLower });
  }
}
