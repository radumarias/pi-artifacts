import type { Frame, Page } from "@cloudflare/puppeteer";
import { ARTIFACT_SANDBOX, type ArtifactManifest, type CallToolResult, type McpError, type McpErrorCode, type ToolInfo } from "../../shared/protocol.ts";
import { clip, errorMessage } from "../../shared/util.ts";
import { PAGE_POLICY, renderArtifact } from "./serve.ts";

/**
 * The check a page goes through before it is published: render it in a headless browser, framed as the viewer frames
 * it, with its live calls answered by the chat's MCP connections, and report what went wrong. Uncaught exceptions,
 * console errors, blocked or failed loads, calls the page got wrong and failed tests are errors, and a page with errors
 * is not published. The screenshot lets the agent see what it built.
 *
 * The page runs in a sandboxed srcdoc frame under the page policy (as a <meta>, since srcdoc has no headers), so it
 * has the opaque origin, the script hosts and the blocked network it has when viewed. A capture script that runs
 * before the runtime reports its errors to the harness page around it, which also plays the viewer's part of the
 * runtime (see src/artifact/broker.ts), in short: every call goes to the Worker through `__piBridge`, and a watch is
 * fetched once. Keep it in step with the runtime's protocol (runtime/pi-runtime.js).
 */

/** A test the agent wrote: the body of an async function run in the page once it has settled. */
export interface CheckTest {
  name: string;
  /** Throws, rejects or returns false to fail; a string it returns is shown with the result. */
  run: string;
}

export type CheckViewport = "desktop" | "mobile";

export interface CheckInput {
  html: string;
  manifest: ArtifactManifest;
  tests?: readonly CheckTest[];
  /** Desktop by default. */
  viewport?: CheckViewport;
}

/** What the harness asks the Worker: one call from the page, or one tool's description. */
export type BridgeRequest =
  | { method: "call"; mode: "read" | "call"; server: string; tool: string; input: unknown }
  | { method: "describe"; server: string; tool: string };

export type BridgeResponse = { ok: true; result?: CallToolResult; tool?: ToolInfo } | { ok: false; error: McpError };

export type Bridge = (request: BridgeRequest) => Promise<BridgeResponse>;

export interface TestResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface CheckReport {
  /** Problems the page must fix before it is published. */
  errors: string[];
  /** Worth a look, but they do not stop a publish: warnings, calls that failed for reasons outside the page. */
  warnings: string[];
  /** One line per server and tool the page called, with how the calls went. */
  calls: string[];
  tests: TestResult[];
  /** The page's visible text, cut. */
  text: string;
  /** JPEG, base64: what the page looked like once settled, for the model. */
  screenshot: string;
  /** A small JPEG data URL of the same, for the chat's step panel. */
  thumb: string;
  width: number;
  height: number;
}

const VIEWPORTS: Record<CheckViewport, { width: number; height: number; isMobile?: boolean; hasTouch?: boolean }> = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844, isMobile: true, hasTouch: true },
};

/** The page has settled once it loaded, has no call in flight and nothing happened for SETTLE_MS, after at least MIN_MS. */
const MIN_MS = 1_500;
const SETTLE_MS = 800;
const MAX_MS = 15_000;
const TEST_MS = 5_000;
/** The tallest page a screenshot shows: a longer page is cut at this height. */
const MAX_SHOT_HEIGHT = 2_400;
/** The longest side the model sees an image at: a larger screenshot would only be scaled down on the way. */
const MAX_SHOT_SIDE = 1_568;
/** The step panel's thumbnail: this wide, and as tall as the panel shows (its max-height at that width). */
const THUMB_WIDTH = 480;
const THUMB_RATIO = 0.75;
const MAX_TEXT = 3_000;
const MAX_LINES = 15;
const MAX_ENTRY = 600;

/** Failures that come from where the page runs (sign-in, an upstream outage, limits), not from how it was written. */
const OUTSIDE_THE_PAGE = new Set<McpErrorCode>(["auth_required", "server_unavailable", "rate_limited", "upstream_error", "not_granted", "cancelled"]);
const failedOutside = (call: CallRecord) => !call.ok && call.code !== undefined && OUTSIDE_THE_PAGE.has(call.code);

/**
 * Text a page shows when it caught a script error and put its message on screen, as pages show a section's error:
 * the failure in the screenshot that started this check ("L.map is not a function"), which no console saw.
 */
const SCRIPT_ERROR_TEXT =
  /[^\n]*\b(?:is not a function|is not defined|is not a constructor|Cannot read propert(?:y|ies) of (?:undefined|null)|Unexpected token)\b[^\n]*/g;

/** Text a page shows when it rendered a value it did not have. */
const SUSPECT_TEXT = /\bNaN\b|\bundefined\b|\[object Object\]|Invalid Date/g;

/**
 * Runs in the page before the runtime: reports uncaught errors, rejections, console errors and warnings, failed loads
 * and policy violations to the harness. One line, as page errors point at lines (see renderForCheck).
 */
const CAPTURE =
  "(()=>{const send=(kind,text,url)=>{try{parent.postMessage({type:'pi:check',kind,text:String(text).slice(0,2000),url},'*')}catch{}};" +
  "const show=(v)=>{if(v instanceof Error)return v.stack&&v.stack.includes(v.message)?v.stack:v.name+': '+v.message+(v.stack?'\\n'+v.stack:'');if(typeof v==='string')return v;try{return JSON.stringify(v)}catch{return String(v)}};" +
  "for(const level of ['error','warn']){const original=console[level];console[level]=function(...args){send(level,args.map(show).join(' '));return original.apply(this,args)}}" +
  "addEventListener('error',(e)=>{if(e instanceof ErrorEvent){send('exception',e.error?show(e.error):e.message+(e.lineno?' (line '+e.lineno+')':''));return}" +
  "const t=e.target;if(t&&t!==window){const url=t.src||t.href||t.tagName;send('resource','Failed to load '+url,url)}},true);" +
  "addEventListener('unhandledrejection',(e)=>send('rejection',show(e.reason)));" +
  "addEventListener('securitypolicyviolation',(e)=>{const url=e.blockedURI||'inline';send('csp','Blocked by the page policy ('+e.effectiveDirective+'): '+url,url)})})();";

/** The viewer's part, played in the top page around the frame. */
const HARNESS = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%;background:#fff}iframe{display:block;border:0;width:100%;height:100%}</style></head><body><script>
const state = { log: [], calls: [], pending: 0, started: Date.now(), active: Date.now(), loaded: false };
window.__check = state;
let frame, manifest, connected = false;
const touch = () => { state.active = Date.now(); };
async function bridge(request) {
  state.pending++;
  touch();
  try {
    return await window.__piBridge(request);
  } catch (error) {
    return { ok: false, error: { code: "upstream_error", message: String((error && error.message) || error) } };
  } finally {
    state.pending--;
    touch();
  }
}
async function call(server, tool, input, mode) {
  const response = await bridge({ method: "call", mode, server, tool, input: input === undefined ? {} : input });
  state.calls.push({ server, tool, ok: response.ok, code: response.ok ? undefined : response.error.code, message: response.ok ? undefined : response.error.message });
  return response;
}
function serve(port) {
  port.onmessage = async (event) => {
    const m = event.data;
    if (!m) return;
    const reply = (r, value) => port.postMessage(r.ok ? { type: "reply", id: m.id, ok: true, value } : { type: "reply", id: m.id, ok: false, error: r.error });
    if (m.type === "request") {
      const p = m.params || {};
      if (m.method === "call") {
        const r = await call(p.server, p.tool, p.input, typeof p.cache === "object" && p.cache !== null ? "read" : "call");
        reply(r, r.ok && r.result);
      } else if (m.method === "describe") {
        const r = await bridge({ method: "describe", server: p.server, tool: p.tool });
        reply(r, r.ok && r.tool);
      } else if (m.method === "invalidate") {
        reply({ ok: true });
      } else {
        reply({ ok: false, error: { code: "bad_request", message: "Unknown method " + m.method } });
      }
    } else if (m.type === "watch") {
      const r = await call(m.server, m.tool, m.input, "read");
      port.postMessage({ type: "watch", watchId: m.watchId, event: r.ok ? { type: "data", result: r.result } : { type: "error", error: r.error } });
    }
  };
}
addEventListener("message", (event) => {
  if (!frame || event.source !== frame.contentWindow) return;
  const data = event.data;
  touch();
  if (data && data.type === "pi:check") {
    if (state.log.length < 200) state.log.push({ kind: String(data.kind), text: String(data.text), url: data.url === undefined ? undefined : String(data.url) });
  } else if (data && data.type === "pi:hello" && !connected) {
    connected = true;
    const channel = new MessageChannel();
    serve(channel.port1);
    event.source.postMessage({ type: "pi:connect", manifest }, "*", [channel.port2]);
  }
});
window.__settled = (minMs, settleMs) => state.loaded && state.pending === 0 && Date.now() - state.active >= settleMs && Date.now() - state.started >= minMs;
window.__start = (html, declared) => {
  manifest = declared;
  state.started = Date.now();
  frame = document.createElement("iframe");
  frame.setAttribute("sandbox", ${JSON.stringify(ARTIFACT_SANDBOX)});
  frame.onload = () => { state.loaded = true; touch(); };
  frame.srcdoc = html;
  document.body.append(frame);
};
</script></body></html>`;

interface LogEntry {
  kind: string;
  text: string;
  /** What a failed or blocked load was. */
  url?: string;
}

interface CallRecord {
  server: string;
  tool: string;
  ok: boolean;
  code?: McpErrorCode;
  message?: string;
}

/** The page as the check renders it: the page policy as a <meta>, the capture script, then the runtime, as when served. */
export function renderForCheck(html: string): { document: string; mapLine: (line: number) => number | undefined } {
  const prelude = `<meta http-equiv="Content-Security-Policy" content="${PAGE_POLICY.replaceAll('"', "&quot;")}"><script>${CAPTURE}</script>`;
  const document = renderArtifact(html, prelude);
  // What renderArtifact added runs from the prelude to the end of the runtime's script, and starts on startLine.
  const start = document.indexOf(prelude);
  const end = document.indexOf("</script>", start + prelude.length);
  const startLine = document.slice(0, start).split("\n").length;
  const added = document.slice(start, end).split("\n").length - 1;
  // A line before it or after it is the page's; the last added line goes on with the page's line it was put into.
  return { document, mapLine: (line) => (line <= startLine ? line : line >= startLine + added ? line - added : undefined) };
}

/** Rejects after `ms`, so a page that never settles a promise cannot hold the check. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} took over ${ms / 1000} s`)), ms)));
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Waits for the frame to lay out and paint what changed (two animation frames), rather than a fixed time. */
const PAINTED = "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))";

/** Render the page in `page` (a fresh one: the check leaves it changed) and report on it. */
export async function checkPage(page: Page, input: CheckInput, bridge: Bridge): Promise<CheckReport> {
  const viewport = VIEWPORTS[input.viewport ?? "desktop"];
  const tests = input.tests ?? [];
  await Promise.all([page.setViewport(viewport), page.exposeFunction("__piBridge", (request: BridgeRequest) => bridge(request))]);
  await page.setContent(HARNESS);
  const { document, mapLine } = renderForCheck(input.html);
  // The Worker has no DOM types, so what runs in the harness is written as strings.
  await page.evaluate(`window.__start(${JSON.stringify(document)}, ${JSON.stringify(input.manifest)})`);
  // One wait in the browser, which polls the harness itself.
  await page.waitForFunction(`window.__settled(${MIN_MS}, ${SETTLE_MS})`, { polling: 100, timeout: MAX_MS }).catch(() => {});
  const state = (await page.evaluate("({ loaded: __check.loaded, pending: __check.pending })")) as { loaded: boolean; pending: number };

  const warnings: string[] = [];
  if (!state.loaded) warnings.push(`The page was still loading after ${MAX_MS / 1000} s.`);
  else if (state.pending > 0) warnings.push(`${state.pending} live call(s) were still running after ${MAX_MS / 1000} s.`);

  const frame = page.frames().find((f) => f !== page.mainFrame());
  let height = viewport.height;
  let shown = { text: "", graphics: 0, scrollHeight: 0 };
  if (frame) {
    shown = await frame
      .evaluate(
        "({ text: document.body ? document.body.innerText : '', scrollHeight: document.documentElement.scrollHeight, " +
          "graphics: [...document.querySelectorAll('canvas,svg,img,video')].filter((e) => e.getBoundingClientRect().width > 0).length })",
      )
      .then((value) => value as typeof shown)
      .catch(() => shown);
    // Show the whole page, up to a limit, rather than its first screen.
    const wanted = Math.min(Math.max(shown.scrollHeight, viewport.height), MAX_SHOT_HEIGHT);
    if (wanted > height) {
      height = wanted;
      await page.setViewport({ ...viewport, height });
      await frame.evaluate(PAINTED).catch(() => {});
    }
  }
  const shot = (width: number, tall: number, scale: number, quality: number) =>
    page.screenshot({ type: "jpeg", quality, encoding: "base64", clip: { x: 0, y: 0, width, height: tall, scale: Math.min(1, scale) } });
  const screenshot = await shot(viewport.width, height, MAX_SHOT_SIDE / Math.max(viewport.width, height), 60);
  const thumb = await shot(viewport.width, Math.min(height, Math.round(viewport.width * THUMB_RATIO)), THUMB_WIDTH / viewport.width, 55);

  const results = frame ? await runTests(frame, tests) : tests.map((test) => ({ name: test.name, ok: false, detail: "The page did not load." }));
  // Errors the tests set off land once the frame has run what they started.
  if (frame && tests.length) await frame.evaluate(PAINTED).catch(() => {});
  const harness = (await page.evaluate("({ log: __check.log, calls: __check.calls })")) as { log: LogEntry[]; calls: CallRecord[] };
  const judged = judge({ ...harness, tests: results, text: shown.text, graphics: shown.graphics, mapLine, manifest: input.manifest });

  return {
    errors: judged.errors,
    warnings: [...warnings, ...judged.warnings].slice(0, MAX_LINES),
    calls: judged.calls,
    tests: results,
    text: clip(shown.text.trim(), MAX_TEXT),
    screenshot,
    thumb: `data:image/jpeg;base64,${thumb}`,
    width: viewport.width,
    height,
  };
}

async function runTests(frame: Frame, tests: readonly CheckTest[]): Promise<TestResult[]> {
  const results: TestResult[] = [];
  // One at a time, each its own evaluation: a test that does not parse fails alone.
  for (const test of tests) {
    try {
      // Evaluated through the devtools protocol: the page policy, which forbids eval, does not apply to it.
      const value = await within(frame.evaluate(`(async () => {\n${test.run}\n})()`), TEST_MS, "The test");
      if (value === false) results.push({ name: test.name, ok: false, detail: "returned false" });
      else results.push({ name: test.name, ok: true, detail: typeof value === "string" ? clip(value, MAX_ENTRY) : undefined });
    } catch (error) {
      results.push({ name: test.name, ok: false, detail: clip(errorMessage(error), MAX_ENTRY) });
    }
  }
  return results;
}

interface Observed {
  log: LogEntry[];
  calls: CallRecord[];
  tests: TestResult[];
  text: string;
  graphics: number;
  mapLine: (line: number) => number | undefined;
  manifest: ArtifactManifest;
}

/** How each kind of log entry reads in the report. */
const KINDS: Record<string, string> = { exception: "Uncaught ", rejection: "Unhandled rejection: ", error: "console.error: ", warn: "console.warn: " };

/** Sort what the check saw into errors and warnings. */
export function judge({ log, calls, tests, text, graphics, mapLine, manifest }: Observed): Pick<CheckReport, "errors" | "warnings" | "calls"> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const outside = calls.some(failedOutside);

  // A load the policy blocked also fails: say it once, as the policy's.
  const blocked = new Set(log.filter((e) => e.kind === "csp").map((e) => e.url));
  const said = log.filter((e) => e.kind !== "resource" || !blocked.has(e.url));
  for (const [entry, count] of tally(said.map((e) => `${e.kind}\u0000${e.text}`))) {
    const [kind, raw] = entry.split("\u0000");
    const line = `${KINDS[kind] ?? ""}${clip(pageLines(raw, mapLine), MAX_ENTRY)}${count > 1 ? ` (×${count})` : ""}`;
    if (kind === "warn") warnings.push(line);
    // The page shows a call's failure as it should, and may log it: not the page's fault when the call failed outside it.
    else if (kind === "error" && outside) warnings.push(`${line} (may come from the live calls that failed)`);
    else errors.push(line);
  }

  const summary = new Map<string, { ok: number; failed: Map<string, number> }>();
  for (const call of calls) {
    const key = `${call.server}/${call.tool}`;
    const entry = summary.get(key) ?? { ok: 0, failed: new Map<string, number>() };
    summary.set(key, entry);
    if (call.ok) {
      entry.ok++;
      continue;
    }
    entry.failed.set(call.code ?? "error", (entry.failed.get(call.code ?? "error") ?? 0) + 1);
    (failedOutside(call) ? warnings : errors).push(`Live call ${key} failed with ${call.code}: ${clip(call.message ?? "", 300)}`);
  }
  const callLines = [...summary].map(([key, { ok, failed }]) => {
    const parts = [ok && `${ok} ok`, ...[...failed].map(([code, n]) => `${n} failed (${code})`)].filter(Boolean);
    return `${key}: ${parts.join(", ")}`;
  });
  if ((manifest.mcp?.servers.length ?? 0) > 0 && calls.length === 0) warnings.push("The page declares MCP tools but called none of them.");

  for (const test of tests) if (!test.ok) errors.push(`Test "${test.name}" failed: ${test.detail ?? "no reason given"}`);

  if (!text.trim() && graphics === 0) errors.push("The page shows nothing: no text and no canvas, svg or image.");
  for (const [line] of tally([...text.matchAll(SCRIPT_ERROR_TEXT)].map((m) => m[0].trim()))) {
    errors.push(`The page shows a script error: "${clip(line, 300)}". Find what threw it (log caught errors with console.error to see where).`);
  }
  for (const [word, count] of tally([...text.matchAll(SUSPECT_TEXT)].map((m) => m[0]))) {
    warnings.push(`The page shows "${word}"${count > 1 ? ` ${count} times` : ""}: a value it rendered without having it?`);
  }

  return { errors: errors.slice(0, MAX_LINES), warnings: [...new Set(warnings)].slice(0, MAX_LINES), calls: callLines };
}

/** Each distinct item with how often it came, in first-seen order. */
function tally(items: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return counts;
}

/** A stack or message with its about:srcdoc positions turned into the agent's page lines. */
function pageLines(text: string, mapLine: (line: number) => number | undefined): string {
  return text.replace(/about:srcdoc:(\d+):(\d+)/g, (_, line: string, column: string) => {
    const mapped = mapLine(Number(line));
    return mapped === undefined ? "(runtime)" : `page line ${mapped}:${column}`;
  });
}

/** What the check found, as the agent reads it after a line saying what came of it (see the tools that check). */
export function describeReport(report: CheckReport): string {
  const { errors, warnings, calls, tests } = report;
  const list = (title: string, items: readonly string[]) => items.length > 0 && `${title}:\n${items.map((item) => `- ${item}`).join("\n")}`;
  const parts = [
    list("Errors", errors),
    list("Warnings", warnings),
    list("Live calls", calls),
    list(
      "Tests",
      tests.map((t) => `${t.ok ? "passed" : "FAILED"}: ${t.name}${t.detail ? ` (${t.detail})` : ""}`),
    ),
    `Visible text:\n${report.text || "(none)"}`,
    `Screenshot at ${report.width}×${report.height}: look at it for anything that renders wrong (overlaps, empty sections, broken charts, unreadable contrast).`,
  ];
  return parts.filter(Boolean).join("\n\n");
}
