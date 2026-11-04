import { memo, useEffect, useState } from "react";
import { highlight } from "./highlight.ts";
import { HIGHLIGHT_LIMIT } from "./preview.ts";

/** Code as highlight.js colours it once its grammar loads; plain until then, or for text too long to colour quickly. */
export const Code = memo(function Code({ text, grammar }: { text: string; grammar: string | undefined }) {
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
