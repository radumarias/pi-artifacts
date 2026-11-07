import { useEffect, useRef, useState } from "react";
import type { ArtifactView } from "../../shared/protocol.ts";
import { errorMessage } from "../../shared/util.ts";
import { api } from "../api.ts";
import { useVisible } from "../sidebar.ts";
import { ArtifactFrame } from "./ArtifactFrame.tsx";
import { ArtifactSource } from "./ArtifactSource.tsx";
import { ShowAs, ViewportPicker, ViewportStage, useViewport } from "./viewport.tsx";
import { FollowButton } from "../feed/FeedNav.tsx";

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
  // Showing the page's source over the page, which stays loaded behind it, so going back does not reload it.
  const [source, setSource] = useState(false);
  // The version whose source was last shown: it stays read and coloured while the page shows, for going back to it.
  const [sourceOf, setSourceOf] = useState<number>();
  const [clone, setClone] = useState<{ command: string; expiresAt: string } | { error: string } | null>(null);
  // Why Discuss could not open the page's chat.
  const [discussError, setDiscussError] = useState<string | null>(null);
  const [discussing, setDiscussing] = useState(false);
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

  // The chat on this page: its author opens (or makes) it, anyone else joins it.
  async function discuss() {
    setDiscussing(true);
    setDiscussError(null);
    try {
      let found = await api.discuss(artifactId);
      if ("canStart" in found) {
        const start = confirm(
          "Start a chat on this page? Anyone who can open the page can join it, read all of it and call its agents, which act as you. You can make it a group or private later.",
        );
        if (!start) return setDiscussing(false);
        found = await api.discuss(artifactId, true);
      }
      if ("chatId" in found) location.href = `/c/${found.chatId}`;
    } catch (e) {
      setDiscussError(errorMessage(e));
      setDiscussing(false);
    }
  }

  if (error) return <div className="panel-empty">Could not load this artifact: {error}</div>;
  if (!meta || version === undefined) return <div className="panel-empty">Loading…</div>;
  const entry = meta.versions.find((v) => v.version === version) ?? meta.versions[meta.versions.length - 1];
  const servers = entry.manifest.mcp?.servers ?? [];
  if (source && sourceOf !== entry.version) setSourceOf(entry.version);

  return (
    <section className={fullPage ? "artifact-panel full" : "artifact-panel"}>
      <header className="artifact-bar">
        <div className="artifact-title">
          <strong>{meta.title}</strong>
          {servers.length > 0 && <span className="pill live">live · {servers.map((s) => s.server).join(", ")}</span>}
        </div>
        <div className="artifact-actions">
          <ShowAs rendered="Preview" source={source} onSource={setSource} />
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
          <button
            type="button"
            onClick={() => void discuss()}
            disabled={discussing}
            title={meta.isOwner ? "Open this page's chat, where anyone who can open the page can join and ask about it" : "Join this page's chat, to ask about it"}
          >
            Discuss
          </button>
          {/* Someone else's page: its new versions, and a chat about it, can reach their feed. */}
          {!meta.isOwner && <FollowButton kind="page" id={meta.id} />}
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
      {discussError && (
        <div className="clone-box">
          <span>{discussError}</span>
        </div>
      )}
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
      <div className="artifact-view">
        <ViewportStage id={viewport.id} rotated={viewport.rotated}>
          <ArtifactFrame
            key={`${entry.version}:${reloads}`}
            artifactId={meta.id}
            version={entry.version}
            manifest={entry.manifest}
            uid={uid}
            title={meta.title}
            covered={source}
          />
        </ViewportStage>
        {sourceOf === entry.version && <ArtifactSource key={sourceOf} artifactId={meta.id} version={sourceOf} hidden={!source} />}
      </div>
    </section>
  );
}
