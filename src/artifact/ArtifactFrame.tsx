import { useEffect, useRef } from "react";
import { ARTIFACT_SANDBOX, type ArtifactManifest } from "../../shared/protocol.ts";
import { api } from "../api.ts";
import { ArtifactBroker } from "./broker.ts";

interface Props {
  artifactId: string;
  version: number;
  manifest: ArtifactManifest;
  /** The signed-in viewer; keys the browser cache, so accounts on one browser never share results. */
  uid: string;
  title: string;
  /** Covered (by the source): it holds its read-only calls as in a hidden tab, and takes no focus. */
  covered?: boolean;
}

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The artifact in a sandboxed iframe (opaque origin, no network of its own)
 * plus the broker that answers its runtime over a MessagePort.
 */
export function ArtifactFrame({ artifactId, version, manifest, uid, title, covered = false }: Props) {
  const ref = useRef<HTMLIFrameElement>(null);
  const coveredRef = useRef(covered);
  // Tells the broker whether anyone can see the page: the tab is showing and nothing covers the frame.
  const showing = useRef<() => void>(() => {});

  useEffect(() => {
    const iframe = ref.current!;
    const broker = new ArtifactBroker({
      artifactId,
      version,
      transport: (call) => api.proxy(artifactId, call),
      describe: () => api.artifactTools(artifactId, version),
      manifest,
      cacheNamespace: uid,
      storage: browserStorage(),
    });

    // The page's runtime says hello as it starts. The first hello from this frame gets the
    // bridge; anything later (a reload, or a page the artifact navigated to) gets nothing.
    // Waiting for the page to ask, rather than counting load events, means an about:blank
    // or an earlier navigation can never take the port.
    let connected = false;
    const onMessage = (event: MessageEvent) => {
      if (connected || event.source !== iframe.contentWindow || event.data?.type !== "pi:hello") return;
      connected = true;
      const channel = new MessageChannel();
      broker.connect(channel.port1);
      (event.source as Window).postMessage({ type: "pi:connect", manifest }, "*", [channel.port2]);
    };
    const onVisibility = () => broker.setHidden(document.visibilityState === "hidden" || coveredRef.current);
    showing.current = onVisibility;

    window.addEventListener("message", onMessage);
    document.addEventListener("visibilitychange", onVisibility);
    onVisibility();
    // Each version gets its own frame (see ArtifactPanel's key), so this only skips the
    // second run of a development-mode double effect.
    const url = api.artifactPageUrl(artifactId, version);
    if (iframe.getAttribute("src") !== url) iframe.src = url;
    return () => {
      window.removeEventListener("message", onMessage);
      document.removeEventListener("visibilitychange", onVisibility);
      showing.current = () => {};
      broker.close();
    };
    // The manifest is fixed per version, so the version stands for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifactId, version, uid]);

  useEffect(() => {
    coveredRef.current = covered;
    showing.current();
  }, [covered]);

  return <iframe ref={ref} className="artifact-frame" title={title} sandbox={ARTIFACT_SANDBOX} inert={covered} />;
}
