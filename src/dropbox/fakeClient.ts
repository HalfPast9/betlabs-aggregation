import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  CreateFileRequestResult,
  DropboxClient,
  DropboxFileEntry,
  ListFolderPage,
  SpaceUsage,
} from "./types.js";

const DEFAULT_FAKE_ALLOCATED_BYTES = 2 * 1024 * 1024 * 1024 * 1024; // 2TB, a plausible business-plan allocation

interface ChangeLogEntry {
  seq: number;
  path: string;
  type: "add" | "delete";
}

/**
 * In-memory stand-in for Dropbox, used in tests and as the DROPBOX_MODE=fake
 * runtime mode (no real Dropbox app/account exists yet — PRD D7). Models just
 * enough of list_folder/continue's incremental-changes semantics for sync.ts
 * to be exercised end to end. Use `seedFile` to simulate a participant upload.
 */
export class FakeDropboxClient implements DropboxClient {
  private readonly files = new Map<string, Buffer>();
  private readonly sizeOverrides = new Map<string, number>();
  private readonly changeLog: ChangeLogEntry[] = [];
  private seq = 0;

  constructor(private readonly allocatedBytes = DEFAULT_FAKE_ALLOCATED_BYTES) {}

  seedFile(pathLower: string, data: Buffer): void {
    this.files.set(pathLower, data);
    this.seq += 1;
    this.changeLog.push({ seq: this.seq, path: pathLower, type: "add" });
  }

  /**
   * Records a file whose *reported* size (for getSpaceUsage) is larger than
   * the bytes actually stored — lets quota-threshold tests exercise multi-TB
   * scenarios without allocating multi-TB buffers.
   */
  seedFileWithReportedSize(pathLower: string, data: Buffer, reportedSizeBytes: number): void {
    this.seedFile(pathLower, data);
    this.sizeOverrides.set(pathLower, reportedSizeBytes);
  }

  async createFileRequest(destinationPath: string, _title: string): Promise<CreateFileRequestResult> {
    const id = `fake-${randomUUID()}`;
    return { id, url: `https://www.dropbox.com/request/${id}?dest=${encodeURIComponent(destinationPath)}` };
  }

  async listFolder(folderPath: string, cursor?: string): Promise<ListFolderPage> {
    const afterSeq = cursor ? Number.parseInt(cursor, 10) : 0;
    const prefix = folderPath.toLowerCase();
    const relevant = this.changeLog.filter(
      (c) => c.seq > afterSeq && c.path.toLowerCase().startsWith(prefix),
    );
    const entries: DropboxFileEntry[] = relevant
      .filter((c) => c.type === "add" && this.files.has(c.path))
      .map((c) => ({ pathLower: c.path, name: basename(c.path), isFile: true }));
    const newCursor = relevant.length > 0 ? String(relevant[relevant.length - 1]!.seq) : String(afterSeq);
    return { entries, cursor: newCursor, hasMore: false };
  }

  async download(pathLower: string): Promise<Buffer> {
    const data = this.files.get(pathLower);
    if (!data) throw new Error(`FakeDropboxClient: no file at ${pathLower}`);
    return data;
  }

  async deleteFile(pathLower: string): Promise<void> {
    if (!this.files.delete(pathLower)) {
      throw new Error(`FakeDropboxClient: no file at ${pathLower}`);
    }
    this.seq += 1;
    this.changeLog.push({ seq: this.seq, path: pathLower, type: "delete" });
  }

  async getSpaceUsage(): Promise<SpaceUsage> {
    let usedBytes = 0;
    for (const [path, buf] of this.files) {
      usedBytes += this.sizeOverrides.get(path) ?? buf.byteLength;
    }
    return { usedBytes, allocatedBytes: this.allocatedBytes };
  }
}
