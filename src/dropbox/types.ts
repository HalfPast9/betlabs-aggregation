export interface DropboxFileEntry {
  /** Dropbox lowercase path, e.g. "/betlab-intake/<enrollmentId>/recording.mp4" */
  pathLower: string;
  name: string;
  /** True for files; entries for folders/deletions are filtered out by the caller. */
  isFile: boolean;
}

export interface ListFolderPage {
  entries: DropboxFileEntry[];
  cursor: string;
  hasMore: boolean;
}

export interface CreateFileRequestResult {
  id: string;
  url: string;
}

export interface SpaceUsage {
  usedBytes: number;
  /** null when the account's allocation type isn't one we recognize. */
  allocatedBytes: number | null;
}

/**
 * Everything the ingest pipeline needs from Dropbox, narrowed to our use case
 * (PRD §6.1). Swappable between a fake in-memory implementation (used in tests
 * and DROPBOX_MODE=fake) and the real SDK-backed client.
 */
export interface DropboxClient {
  createFileRequest(destinationPath: string, title: string): Promise<CreateFileRequestResult>;
  /**
   * Pass the previously stored cursor to continue a listing
   * (`list_folder/continue`); omit it for the first page (`list_folder`).
   */
  listFolder(folderPath: string, cursor?: string): Promise<ListFolderPage>;
  download(pathLower: string): Promise<Buffer>;
  deleteFile(pathLower: string): Promise<void>;
  /** PRD §12 risk: "Dropbox quota fills, uploads silently rejected" — this is the mitigation's data source. */
  getSpaceUsage(): Promise<SpaceUsage>;
}
