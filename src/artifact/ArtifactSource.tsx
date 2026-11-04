import { useEffect, useState } from "react";
import { errorMessage } from "../../shared/util.ts";
import { api } from "../api.ts";
import { Code } from "../files/Code.tsx";
import { grammarFor } from "../files/highlight.ts";

const HTML = grammarFor("html");

/** One version of an artifact as the agent wrote it, highlighted, to read: none of it runs. Keyed by the version. */
export function ArtifactSource({ artifactId, version }: { artifactId: string; version: number }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    api.artifactSource(artifactId, version, abort.signal).then(
      (text) => !abort.signal.aborted && setText(text),
      (error) => !abort.signal.aborted && setError(errorMessage(error)),
    );
    return () => abort.abort();
  }, [artifactId, version]);
  if (error) return <div className="panel-empty">Could not load the source: {error}</div>;
  if (text === null) return <div className="panel-empty">Loading…</div>;
  return (
    <div className="file-body">
      <pre className="file-code">
        <Code text={text} grammar={HTML} />
      </pre>
    </div>
  );
}
