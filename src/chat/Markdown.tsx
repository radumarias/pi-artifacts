import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// Links open in a new tab. react-markdown renders no raw HTML and its default
// URL check drops javascript: and other unsafe links; this keeps only links
// that resolve to http(s) or mailto, since the text comes from the model and
// from MCP servers. Paths in this app (such as a sign-in link) resolve to http(s).
const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
function isSafeLink(href: string): boolean {
  try {
    return SAFE_PROTOCOLS.has(new URL(href, "https://app.invalid/").protocol);
  } catch {
    return false;
  }
}

const components: Components = {
  a: ({ href, children }) =>
    href && isSafeLink(href) ? (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    ) : (
      <>{children}</>
    ),
  // Images in model text would load from anywhere; show the alt text instead.
  img: ({ alt }) => <>{alt ?? ""}</>,
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  ),
};

const plugins = [remarkGfm];

/** An assistant message as Markdown (GitHub flavour: tables, task lists, strikethrough, autolinked URLs). */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={plugins} components={components}>
      {text}
    </ReactMarkdown>
  );
});
