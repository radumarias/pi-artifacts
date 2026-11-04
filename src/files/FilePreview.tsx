import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { baseName, extension } from "../../shared/attachments.ts";
import { ARTIFACT_SANDBOX } from "../../shared/protocol.ts";
import { previewKind, viewType, type PreviewKind } from "../../shared/uploads.ts";
import { errorMessage, formatBytes } from "../../shared/util.ts";
import { api, type FileInfo } from "../api.ts";
import { ViewportPicker, ViewportStage, useViewport } from "../artifact/viewport.tsx";
import { isSafeLink, markdownComponents, markdownPlugins } from "../chat/Markdown.tsx";
import { opensElsewhere } from "../layout.tsx";
import { grammarFor, highlight } from "./highlight.ts";
import { HIGHLIGHT_LIMIT, parseTable, readText, resolveLink, TABLE_ROWS, TEXT_LIMIT, type FileText } from "./preview.ts";

interface Props {
  path: string;
  /** The user's files: links in a Markdown file open those they point to here, and its images show from them. */
  files: readonly FileInfo[];
  onOpen: (path: string) => void;
  onClose: () => void;
}

/** Code as highlight.js colours it once its grammar loads; plain until then, or for text too long to colour quickly. */
const Code = memo(function Code({ text, grammar }: { text: string; grammar: string | undefined }) {
  const [html, setHtml] = useState<{ text: string; html: string } | null>(null);
  useEffect(() => {
    if (!grammar || text.length > HIGHLIGHT_LIMIT) return;
    let live = true;
    highlight(text, grammar).then(
      (html) => live && setHtml({ text, html }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [text, grammar]);
  // highlight.js escapes the code's text: the HTML is only its spans around it.
  return html?.text === text ? <code className="hljs" dangerouslySetInnerHTML={{ __html: html.html }} /> : <code>{text}</code>;
});

/**
 * The file's text, read when it opens and again on a reload (not again when the panel goes back to showing it);
 * null while reading or when it is not text. Only the first TEXT_LIMIT bytes (and one more, to tell there are more) are asked for.
 */
function useFileText(path: string, reload: string, wanted: boolean): { text: FileText | null; binary: boolean; error: string | null } {
  const [state, setState] = useState<{ key: string; text: FileText | null; error: string | null }>({ key: "", text: null, error: null });
  const key = `${path}\n${reload}`;
  const loaded = state.key === key && !state.error;
  useEffect(() => {
    if (!wanted || loaded) return;
    const abort = new AbortController();
    api
      .fileStart(path, TEXT_LIMIT + 1, abort.signal)
      .then((body) => (body ? readText(body, TEXT_LIMIT, !!previewKind(path)) : { text: "", cut: false }))
      .then(
        (text) => !abort.signal.aborted && setState({ key, text, error: null }),
        (error) => !abort.signal.aborted && setState({ key, text: null, error: errorMessage(error) }),
      );
    return () => abort.abort();
  }, [path, key, wanted, loaded]);
  const current = state.key === key;
  return { text: current ? state.text : null, binary: current && !state.text && !state.error, error: current ? state.error : null };
}

/**
 * A Markdown file rendered as the chat renders the agent's messages, except that its links to `known` files open
 * them here and its images show from the user's files.
 */
const MarkdownView = memo(function MarkdownView({
  path,
  text,
  known,
  onOpen,
}: {
  path: string;
  text: string;
  known: ReadonlySet<string>;
  onOpen: (path: string) => void;
}) {
  const components = useMemo<Components>(() => {
    /** Where a link in this file points among the user's files, if it is one of them. */
    const fileAt = (href: unknown) => {
      const target = typeof href === "string" ? resolveLink(path, href) : null;
      return target && known.has(target) ? target : null;
    };
    return {
      ...markdownComponents,
      a: ({ href, children }) => {
        const target = fileAt(href);
        if (target) {
          return (
            <a
              href={api.fileViewUrl(target)}
              title={target}
              onClick={(event) => {
                if (opensElsewhere(event)) return;
                event.preventDefault();
                onOpen(target);
              }}
            >
              {children}
            </a>
          );
        }
        // Elsewhere, only a full link to another site opens (in a new tab), as in the chat; not a path in the app.
        return href && /^[a-z][a-z0-9+.-]*:/i.test(href) && isSafeLink(href) ? (
          <a href={href} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        ) : (
          <>{children}</>
        );
      },
      // Only the user's own images load, from the app (served so nothing in them runs); an image from elsewhere would
      // tell that site the file was opened, so its alt text shows instead.
      img: ({ src, alt }) => {
        const target = fileAt(src);
        return target ? <img src={api.fileViewUrl(target)} alt={alt ?? ""} /> : <>{alt ?? ""}</>;
      },
      code: ({ className, children }) => {
        const language = /\blanguage-(\S+)/.exec(className ?? "")?.[1];
        const text = String(children ?? "");
        // A fenced block (it has a language, or spans lines) is highlighted; inline code stays as it is.
        return language || text.includes("\n") ? (
          <Code text={text.replace(/\n$/, "")} grammar={language && grammarFor(language)} />
        ) : (
          <code>{children}</code>
        );
      },
    };
  }, [path, known, onOpen]);
  return (
    <article className="file-markdown">
      <ReactMarkdown remarkPlugins={markdownPlugins} components={components}>
        {text}
      </ReactMarkdown>
    </article>
  );
});

/** A CSV or TSV as a table, its first row as the heading. */
const TableView = memo(function TableView({ path, text }: { path: string; text: string }) {
  const { rows, cut } = useMemo(() => parseTable(text, extension(path) === "tsv" ? "\t" : ","), [path, text]);
  if (rows.length === 0) return <p className="file-note">This table is empty.</p>;
  const [head, ...body] = rows;
  const width = Math.max(...rows.map((row) => row.length));
  const cells = (row: string[], Cell: "th" | "td") => Array.from({ length: width }, (_, i) => <Cell key={i}>{row[i] ?? ""}</Cell>);
  return (
    <div className="file-table">
      <table>
        <thead>
          <tr>{cells(head, "th")}</tr>
        </thead>
        <tbody>
          {body.map((row, i) => (
            <tr key={i}>{cells(row, "td")}</tr>
          ))}
        </tbody>
      </table>
      {cut && <p className="file-note">Showing the first {TABLE_ROWS.toLocaleString("en")} rows; download the file for the rest.</p>}
    </div>
  );
});

/** The two ways a Markdown file, a table or a web page shows: as it renders, or as its source. */
const RENDERED: Partial<Record<PreviewKind, string>> = { markdown: "Preview", table: "Table", html: "Preview" };

/** The kinds the browser shows from the file's URL. */
const BY_URL: ReadonlySet<PreviewKind> = new Set(["image", "audio", "video", "html", "pdf"]);

/**
 * A user file beside the chat, where an artifact shows: an image as itself, sound and video in the browser's player, a web page running in a sandboxed frame
 * (as an artifact does, with no network of its own), a PDF in the browser's viewer, Markdown rendered, a table as
 * one, and any other text, code highlighted. A file that is not text offers its download. Keyed by its path, so
 * another file starts afresh.
 */
export const FilePreview = memo(function FilePreview({ path, files, onOpen, onClose }: Props) {
  const kind = previewKind(path);
  const size = files.find((file) => file.path === path)?.size;
  // The paths, as a set that changes only when they do: a listing comes after every agent run, mostly the same, and a
  // new set would render a Markdown file whole again.
  const listing = files.map((file) => file.path).join("\n");
  const known = useMemo(() => new Set(listing.split("\n")), [listing]);
  const [source, setSource] = useState(false);
  const [reloads, setReloads] = useState(0);
  const viewport = useViewport();
  // A file the agent wrote again is read again: the listing that tells of it has its new size.
  const reload = `${reloads}:${size ?? ""}`;
  const rendered = kind ? RENDERED[kind] : undefined;
  // How it shows now: as its kind, or as text (its source, or a file of a kind the preview does not know).
  const shown: PreviewKind = (source && rendered) || !kind ? "text" : kind;
  // The browser shows these from their URL; the others are read as text here.
  const { text, binary, error } = useFileText(path, reload, !BY_URL.has(shown));
  const name = baseName(path);
  const folder = path.slice(0, -name.length);
  const viewUrl = `${api.fileViewUrl(path)}&r=${encodeURIComponent(reload)}`;

  let body: ReactNode;
  if (shown === "image") {
    body = (
      <div className="file-image">
        <img src={viewUrl} alt={name} />
      </div>
    );
  } else if (shown === "audio" || shown === "video") {
    // The Worker answers range requests, so the player can seek (and Safari plays video at all).
    body = (
      <div className="file-image">
        {shown === "audio" ? <audio key={viewUrl} src={viewUrl} controls /> : <video key={viewUrl} src={viewUrl} controls />}
      </div>
    );
  } else if (shown === "html") {
    body = (
      <ViewportStage id={viewport.id} rotated={viewport.rotated}>
        <iframe key={viewUrl} className="artifact-frame" title={name} src={viewUrl} sandbox={ARTIFACT_SANDBOX} />
      </ViewportStage>
    );
  } else if (shown === "pdf") {
    // No sandbox: browsers refuse to show a PDF in one. The Worker serves it under a policy that loads nothing.
    body = <iframe key={viewUrl} className="artifact-frame file-pdf" title={name} src={viewUrl} />;
  } else if (error) {
    body = (
      <div className="panel-empty">
        Could not open {name}: {error}
      </div>
    );
  } else if (binary) {
    body = (
      <div className="panel-empty">
        <p>
          No preview for {name}: it is not text.{" "}
          <a className="button" href={api.fileUrl(path)} download={name}>
            Download it
          </a>
        </p>
      </div>
    );
  } else if (!text) {
    body = <div className="panel-empty">Loading…</div>;
  } else {
    const cut = text.cut && <p className="file-note">Showing the first {formatBytes(TEXT_LIMIT)}; download the file for the rest.</p>;
    body = (
      <div className="file-body">
        {shown === "markdown" ? (
          <MarkdownView path={path} text={text.text} known={known} onOpen={onOpen} />
        ) : shown === "table" ? (
          <TableView path={path} text={text.text} />
        ) : (
          <pre className="file-code">
            <Code text={text.text} grammar={grammarFor(extension(path) || name)} />
          </pre>
        )}
        {cut}
      </div>
    );
  }

  return (
    <section className="artifact-panel file-preview">
      <header className="artifact-bar">
        <div className="artifact-title" title={path}>
          <strong>
            {folder && <span className="file-folder-path">{folder}</span>}
            {name}
          </strong>
          {size !== undefined && <small className="file-size">{formatBytes(size)}</small>}
        </div>
        <div className="artifact-actions">
          {shown === "html" && <ViewportPicker viewport={viewport} />}
          {rendered && (
            <div className="viewport-picker" role="group" aria-label="Show as">
              <button type="button" aria-pressed={!source} onClick={() => setSource(false)}>
                {rendered}
              </button>
              <button type="button" aria-pressed={source} onClick={() => setSource(true)}>
                Source
              </button>
            </div>
          )}
          <button type="button" onClick={() => setReloads((n) => n + 1)} title="Read the file again">
            ↻
          </button>
          {viewType(path) && (
            <a className="button" href={api.fileViewUrl(path)} target="_blank" rel="noopener" title="Open in a new tab">
              ↗
            </a>
          )}
          <a className="button" href={api.fileUrl(path)} download={name} title={`Download ${name}`}>
            ↓
          </a>
          <button type="button" onClick={onClose} title="Close the preview">
            ✕
          </button>
        </div>
      </header>
      {body}
    </section>
  );
});
