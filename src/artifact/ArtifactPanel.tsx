import { useEffect, useRef, useState } from "react";
import type { ArtifactView } from "../../shared/protocol.ts";
import { errorMessage } from "../../shared/util.ts";
import { api } from "../api.ts";
import { useVisible } from "../sidebar.ts";
import { ArtifactFrame } from "./ArtifactFrame.tsx";
import { ArtifactSource } from "./ArtifactSource.tsx";
import { ViewportPicker, ViewportStage, useViewport } from "./viewport.tsx";

interface Props {
  artifactId: string;
  /** The newest version this chat knows of; a change reloads the metadata and shows it. */
  latestKnown?: number;
  uid: string;
  onClose?: () => void;
  fullPage?: boolean;
}

export function ArtifactPanel({ artifactId, latestKnown, uid, onClose, fullPage }: Props) {
  const [meta, setMeta] = useState<ArtifactView | null>(null);
  const [version, setVersion] = useState<number | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  // Showing the page's source instead of the page. The page stays loaded behind it, so going back does not reload it.
  const [source, setSource] = useState(false);
  const [clone, setClone] = useState<{ command: string; expiresAt: string } | { error: string } | null>(null);
  const viewport = useViewport();

  useEffect(() => {
    let cancelled = false;
    api
      .artifact(artifactId, fullPage)
      .then((m) => {
        if (cancelled) return;
        setMeta(m);
        setVersion(m.latest);
        setError(null);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [artifactId, latestKnown, fullPage]);

  // Its owner has seen the newest version once the window shows it, as a chat is seen: no longer new in their sidebar.
  const visible = useVisible();
  const seenId = meta?.isOwner ? meta.id : undefined;
  const seenVersion = meta?.latest;
  // What this panel last reported, so showing the window again does not report it again.
  const reported = useRef("");
  useEffect(() => {
    if (!seenId || seenVersion === undefined || !visible || reported.current === `${seenId}:${seenVersion}`) return;
    reported.current = `${seenId}:${seenVersion}`;
    api.markArtifactSeen(seenId, seenVersion).catch(() => {});
  }, [seenId, seenVersion, visible]);

  async function showClone() {
    try {
      const access = await api.cloneAccess(artifactId);
      // The token goes in a one-off -c option, so it is not saved in the clone's .git/config.
      setClone({ command: `git -c http.extraHeader="Authorization: Bearer ${access.token}" clone ${access.remote}`, expiresAt: access.expiresAt });
    } catch (e) {
      setClone({ error: errorMessage(e) });
    }
  }

  if (error) return <div className="panel-empty">Could not load this artifact: {error}</div>;
  if (!meta || version === undefined) return <div className="panel-empty">Loading…</div>;
  const entry = meta.versions.find((v) => v.version === version) ?? meta.versions[meta.versions.length - 1];
  const servers = entry.manifest.mcp?.servers ?? [];

  return (
    <section className={fullPage ? "artifact-panel full" : "artifact-panel"}>
      <header className="artifact-bar">
        <div className="artifact-title">
          <strong>{meta.title}</strong>
          {servers.length > 0 && <span className="pill live">live · {servers.map((s) => s.server).join(", ")}</span>}
        </div>
        <div className="artifact-actions">
          <div className="viewport-picker" role="group" aria-label="Show as">
            <button type="button" aria-pressed={!source} onClick={() => setSource(false)}>
              Preview
            </button>
            <button type="button" aria-pressed={source} onClick={() => setSource(true)} title="Read the page's code">
              Source
            </button>
          </div>
          {!source && <ViewportPicker viewport={viewport} />}
          <select value={entry.version} onChange={(e) => setVersion(Number(e.target.value))} aria-label="Version">
            {[...meta.versions].reverse().map((v) => (
              <option key={v.version} value={v.version} title={v.message}>
                v{v.version}
                {v.version === meta.latest ? " (latest)" : ""}
                {v.message ? ` · ${v.message.length > 40 ? `${v.message.slice(0, 39)}…` : v.message}` : ""}
              </option>
            ))}
          </select>
          {source ? (
            <a
              className="button"
              href={api.artifactSourceUrl(meta.id, entry.version)}
              download={`${meta.title} v${entry.version}.html`}
              title="Download this version's code"
            >
              ↓
            </a>
          ) : (
            <button type="button" onClick={() => setReloads((n) => n + 1)} title="Reload the page">
              ↻
            </button>
          )}
          {meta.isOwner && (
            <button type="button" onClick={() => (clone ? setClone(null) : void showClone())} title="Clone this artifact's Git repository">
              git
            </button>
          )}
          {/* Only people in the chat that builds it are told which chat that is. */}
          {meta.chatId && (
            <a className="button primary" href={`/c/${meta.chatId}?artifact=${meta.id}`} title="Open the chat that builds this artifact, with it beside the chat">
              Edit in chat
            </a>
          )}
          {!fullPage && (
            <a className="button" href={`/a/${meta.id}`} target="_blank" rel="noreferrer" title="Open on its own page to share">
              ↗
            </a>
          )}
          {onClose && (
            <button type="button" onClick={onClose} title="Close the preview">
              ✕
            </button>
          )}
        </div>
      </header>
      {clone && (
        <div className="clone-box">
          {"error" in clone ? (
            <span>{clone.error}</span>
          ) : (
            <>
              <code>{clone.command}</code>
              <button type="button" onClick={() => void navigator.clipboard.writeText(clone.command)}>
                Copy
              </button>
              <small>Read-only, this repository only, until {new Date(clone.expiresAt).toLocaleTimeString()}.</small>
            </>
          )}
        </div>
      )}
      {source && <ArtifactSource key={entry.version} artifactId={meta.id} version={entry.version} />}
      <ViewportStage id={viewport.id} rotated={viewport.rotated} hidden={source}>
        <ArtifactFrame key={`${entry.version}:${reloads}`} artifactId={meta.id} version={entry.version} manifest={entry.manifest} uid={uid} title={meta.title} />
      </ViewportStage>
    </section>
  );
}
