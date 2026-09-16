import { Dropbox } from "dropbox";
import type {
  CreateFileRequestResult,
  DropboxClient,
  DropboxFileEntry,
  ListFolderPage,
  SpaceUsage,
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
      ? await this.continueOrRecover(folderPath, cursor)
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

  /**
   * A stored cursor can go bad for reasons outside our control — Dropbox
   * documents that cursors can be invalidated (`reset`), and in practice any
   * malformed value (a corrupted DB row, or here, a mode switch that left a
   * cursor from a different Dropbox client behind) gets a plain 400 rather
   * than a typed error. Recovering by falling back to a fresh list_folder,
   * rather than failing forever, is what actually matters in production —
   * a permanently stuck sync loop is worse than reprocessing one page.
   */
  private async continueOrRecover(folderPath: string, cursor: string) {
    try {
      return await this.dbx.filesListFolderContinue({ cursor });
    } catch (err) {
      console.error(`Dropbox cursor invalid, resetting and re-listing ${folderPath}:`, err);
      return this.dbx.filesListFolder({ path: folderPath, recursive: true });
    }
  }

  async download(pathLower: string): Promise<Buffer> {
    const res = await this.dbx.filesDownload({ path: pathLower });
    const binary = (res.result as unknown as { fileBinary: Uint8Array }).fileBinary;
    return Buffer.from(binary);
  }

  async deleteFile(pathLower: string): Promise<void> {
    await this.dbx.filesDeleteV2({ path: pathLower });
  }

  async getSpaceUsage(): Promise<SpaceUsage> {
    const res = await this.dbx.usersGetSpaceUsage();
    const allocation = res.result.allocation as { ".tag": string; allocated?: number };
    return {
      usedBytes: res.result.used,
      allocatedBytes: typeof allocation.allocated === "number" ? allocation.allocated : null,
    };
  }
}
