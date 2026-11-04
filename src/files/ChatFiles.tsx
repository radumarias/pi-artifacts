import { baseName } from "../../shared/attachments.ts";
import { formatBytes } from "../../shared/util.ts";
import { api, type FileInfo } from "../api.ts";
import { opensElsewhere } from "../layout.tsx";
import { DownloadIcon } from "./FilesNav.tsx";

/**
 * The files of a chat someone shared with this user: its owner's, attached in it or saved by its agent. Each opens in
 * the preview, served from the chat (`base`), or downloads.
 */
export function ChatFiles({
  files,
  base,
  openFile,
  onOpenFile,
}: {
  files: readonly FileInfo[];
  base: string;
  openFile: string | null;
  onOpenFile: (path: string) => void;
}) {
  if (files.length === 0) return <p className="nav-empty">No files in this chat yet.</p>;
  return (
    <nav className="chat-files">
      {files.map((file) => {
        const name = baseName(file.path);
        return (
          <div key={file.path} className="file-row">
            <a
              className={openFile === file.path ? "file-name active" : "file-name"}
              href={api.fileViewUrl(file.path, base)}
              title={`${file.path} · ${formatBytes(file.size)}`}
              onClick={(event) => {
                if (opensElsewhere(event)) return;
                event.preventDefault();
                onOpenFile(file.path);
              }}
            >
              {name}
            </a>
            <a className="file-action" href={api.fileUrl(file.path, base)} download={name} title={`Download ${name}`}>
              <DownloadIcon />
            </a>
          </div>
        );
      })}
    </nav>
  );
}
