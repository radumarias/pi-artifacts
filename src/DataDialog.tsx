import { useEffect, useRef, useState } from "react";
import { errorMessage, formatBytes, plural } from "../shared/util.ts";
import { download, exportData, exportName, type Progress } from "./data/export.ts";
import { importData, KINDS, type ImportReport } from "./data/import.ts";
import { Icon } from "./Icon.tsx";

/** What the dialog is for: taking everything out as a zip, or bringing a zip in. */
export type DataMode = "export" | "import";

/**
 * Export or import everything the user has (src/data/), from the account menu. It runs in this window, a piece at a
 * time, and shows how far it is; it cannot be closed while it runs, or the export would be lost half made.
 */
export function DataDialog({ mode, onClose }: { mode: DataMode; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exported, setExported] = useState<{ zip: Blob; name: string } | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [file, setFile] = useState<File | null>(null);

  useEffect(() => dialog.current?.showModal(), []);

  // Leaving the page mid-run loses it: the browser asks first.
  useEffect(() => {
    if (!running) return;
    const hold = (event: BeforeUnloadEvent) => event.preventDefault();
    addEventListener("beforeunload", hold);
    return () => removeEventListener("beforeunload", hold);
  }, [running]);

  const run = async (work: () => Promise<void>) => {
    setRunning(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRunning(false);
    }
  };

  const startExport = () =>
    run(async () => {
      const zip = await exportData(setProgress);
      const name = exportName();
      setExported({ zip, name });
      download(zip, name);
    });

  const startImport = (zip: File) =>
    run(async () => {
      setReport(await importData(zip, setProgress));
    });

  const done = exported !== null || report !== null;
  return (
    <dialog ref={dialog} className="confirm-dialog prompt-dialog data-dialog" onClose={onClose} onCancel={(e) => running && e.preventDefault()}>
      <h2>{mode === "export" ? "Export your data" : "Import data"}</h2>
      {mode === "export" ? (
        <p className="prompt-about">
          One zip with your chats, artifacts with every version, files, skills, agents, system prompt and what pages saved for you. Import it here or on another
          deployment, from this menu. Your sign-ins to MCP servers stay here, chats others shared with you stay with them, and the people in your shared chats
          are not part of it: an imported chat has only you in it.
        </p>
      ) : (
        <p className="prompt-about">
          Bring in an export from this or another deployment. It adds to what you have and replaces nothing: a chat, artifact, file or skill you have already is
          skipped, so after a failure you can import the same zip again.
        </p>
      )}
      {mode === "import" && !done && (
        <label className="data-file">
          <span>Export zip</span>
          <input type="file" accept=".zip,application/zip" disabled={running} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
      )}
      {progress && !done && <ProgressBar progress={progress} />}
      {exported && (
        <p className="data-done">
          <Icon size={16}>
            <path d="M5 12l5 5L20 7" />
          </Icon>
          Saved {exported.name} ({formatBytes(exported.zip.size)}).{" "}
          <button type="button" className="link-button" onClick={() => download(exported.zip, exported.name)}>
            Download again
          </button>
        </p>
      )}
      {report && <ImportSummary report={report} />}
      {error && <p className="form-error">{error}</p>}
      <div className="confirm-actions">
        <button type="button" disabled={running} onClick={() => dialog.current?.close()}>
          {done ? "Close" : "Cancel"}
        </button>
        {!done && mode === "export" && (
          <button type="button" className="primary" disabled={running} onClick={() => void startExport()}>
            {running ? "Exporting…" : "Export"}
          </button>
        )}
        {!done && mode === "import" && (
          <button type="button" className="primary" disabled={running || !file} onClick={() => file && void startImport(file)}>
            {running ? "Importing…" : "Import"}
          </button>
        )}
      </div>
    </dialog>
  );
}

function ProgressBar({ progress }: { progress: Progress }) {
  return (
    <div className="data-progress">
      <progress max={Math.max(1, progress.total)} value={progress.done} />
      <small>
        {progress.done.toLocaleString()} of {progress.total.toLocaleString()} · {progress.now}
      </small>
    </div>
  );
}

const NOUNS: Record<(typeof KINDS)[number], string> = { chats: "chat", artifacts: "artifact", files: "file", skills: "skill", agents: "agent" };

function ImportSummary({ report }: { report: ImportReport }) {
  const imported = KINDS.filter((kind) => report.imported[kind]).map((kind) => plural(report.imported[kind], NOUNS[kind]));
  const skipped = KINDS.filter((kind) => report.skipped[kind]).map((kind) => plural(report.skipped[kind], NOUNS[kind]));
  return (
    <div className="data-report">
      <p>
        <strong>Imported:</strong> {imported.length ? imported.join(", ") : "nothing new"}
        {report.settings.length ? `; set your ${report.settings.join(", ")}` : ""}.
      </p>
      {skipped.length > 0 && <p>Already here, so left as they are: {skipped.join(", ")}.</p>}
      {report.failed.length > 0 && (
        <>
          <p className="form-error">{plural(report.failed.length, "piece")} failed. Import the same zip again to retry them:</p>
          <ul>
            {report.failed.slice(0, 20).map((failure) => (
              <li key={failure}>{failure}</li>
            ))}
            {report.failed.length > 20 && <li>and {report.failed.length - 20} more</li>}
          </ul>
        </>
      )}
    </div>
  );
}
