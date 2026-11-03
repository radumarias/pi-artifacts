import type { Frame, Page } from "@cloudflare/puppeteer";
import type { ArtifactManifest, CallToolResult, McpError, McpErrorCode, ToolInfo } from "../../shared/protocol.ts";
import { clip } from "../../shared/util.ts";
import { ARTIFACT_SANDBOX, PAGE_POLICY, renderArtifact } from "./serve.ts";

/**
 * The check a page goes through before it is published: render it in a headless browser, framed as the viewer frames
 * it, with its live calls answered by the chat's MCP connections, and report what went wrong. Uncaught exceptions,
 * console errors, blocked or failed loads, calls the page got wrong and failed tests are errors, and a page with errors
 * is not published. The screenshot lets the agent see what it built.
 *
 * The page runs in a sandboxed srcdoc frame under the page policy (as a <meta>, since srcdoc has no headers), so it
 * has the opaque origin, the script hosts and the blocked network it has when viewed. A capture script that runs
 * before the runtime reports its errors to the harness page around it, which also plays the viewer's part of the
 * runtime (see src/artifact/broker.ts): every call goes to the Worker through `__piBridge`.
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
  tests: readonly CheckTest[];
  viewport: CheckViewport;
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
const POLL_MS = 250;
const TEST_MS = 5_000;
/** The tallest page a screenshot shows: a longer page is cut at this height. */
const MAX_SHOT_HEIGHT = 2_400;
const THUMB_WIDTH = 480;
const MAX_TEXT = 3_000;
const MAX_LINES = 15;
const MAX_ENTRY = 600;

/** Failures that come from where the page runs (sign-in, an upstream outage, limits), not from how it was written. */
const OUTSIDE_THE_PAGE = new Set<McpErrorCode>(["auth_required", "server_unavailable", "rate_limited", "upstream_error", "not_granted", "cancelled"]);

/** Text a page shows when it caught a script error and put its message on screen, as pages show a section's error. */
const SCRIPT_ERROR_TEXT =
  /[^\n]*\b(?:is not a function|is not defined|is not a constructor|Cannot read propert(?:y|ies) of (?:undefined|null)|Unexpected token)\b[^\n]*/g;

/** Text a page shows when it rendered a value it did not have. */
const SUSPECT_TEXT = /\bNaN\b|\bundefined\b|\[object Object\]|Invalid Date/g;

/**
 * Runs in the page before the runtime: reports uncaught errors, rejections, console errors and warnings, failed loads
 * and policy violations to the harness. One line, as page errors point at lines (see renderForCheck).
 */
const CAPTURE =
  "(()=>{const send=(kind,text)=>{try{parent.postMessage({type:'pi:check',kind,text:String(text).slice(0,2000)},'*')}catch{}};" +
  "const show=(v)=>{if(v instanceof Error)return v.stack&&v.stack.includes(v.message)?v.stack:v.name+': '+v.message+(v.stack?'\\n'+v.stack:'');if(typeof v==='string')return v;try{return JSON.stringify(v)}catch{return String(v)}};" +
  "for(const level of ['error','warn']){const original=console[level];console[level]=function(...args){send(level,args.map(show).join(' '));return original.apply(this,args)}}" +
  "addEventListener('error',(e)=>{if(e instanceof ErrorEvent){send('exception',e.error?show(e.error):e.message+(e.lineno?' (line '+e.lineno+')':''));return}" +
  "const t=e.target;if(t&&t!==window)send('resource','Failed to load '+(t.src||t.href||t.tagName))},true);" +
  "addEventListener('unhandledrejection',(e)=>send('rejection',show(e.reason)));" +
  "addEventListener('securitypolicyviolation',(e)=>send('csp','Blocked by the page policy ('+e.effectiveDirective+'): '+(e.blockedURI||'inline')))})();";

/** The viewer's part, played in the top page around the frame. */
const HARNESS = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%;background:#fff}iframe{display:block;border:0;width:100%;height:100%}</style></head><body><script>
const state = { log: [], calls: [], pending: 0, active: Date.now(), loaded: false, connected: false, used: false };
window.__check = state;
let frame, manifest;
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
    state.used = true;
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
    if (state.log.length < 200) state.log.push({ kind: String(data.kind), text: String(data.text) });
  } else if (data && data.type === "pi:hello" && !state.connected) {
    state.connected = true;
    const channel = new MessageChannel();
    serve(channel.port1);
    event.source.postMessage({ type: "pi:connect", manifest }, "*", [channel.port2]);
  }
});
window.__start = (html, declared) => {
  manifest = declared;
  frame = document.createElement("iframe");
  frame.setAttribute("sandbox", ${JSON.stringify(ARTIFACT_SANDBOX)});
  frame.onload = () => { state.loaded = true; touch(); };
  frame.srcdoc = html;
  document.body.append(frame);
};
</script></body></html>`;

interface HarnessState {
  log: { kind: string; text: string }[];
  calls: { server: string; tool: string; ok: boolean; code?: McpErrorCode; message?: string }[];
  pending: number;
  active: number;
  loaded: boolean;
  /** The page's runtime said hello. */
  connected: boolean;
  /** The page asked for something over the port: it called pi.use("mcp") and then a tool. */
  used: boolean;
}

/** Evaluate an expression in the harness page. The Worker has no DOM types, so the expression is a string. */
async function inHarness<T>(page: Page, expression: string): Promise<T> {
  return (await page.evaluate(expression)) as T;
}

/** The page as the check renders it: the page policy as a <meta>, the capture script, then the runtime, as when served. */
export function renderForCheck(html: string): { document: string; mapLine: (line: number) => number | undefined } {
  const prelude = `<meta http-equiv="Content-Security-Policy" content="${PAGE_POLICY.replaceAll('"', "&quot;")}"><script>${CAPTURE}</script>`;
  const document = renderArtifact(html, prelude);
  // What renderArtifact added runs from the prelude to the end of the runtime's script, and starts on startLine.
  const start = document.indexOf(prelude);
  const end = document.indexOf("</script>", start + prelude.length);
  const startLine = lines(document.slice(0, start));
  const added = lines(document.slice(start, end)) - 1;
  // A line before it or after it is the page's; the last added line goes on with the page's line it was put into.
  return { document, mapLine: (line) => (line <= startLine ? line : line >= startLine + added ? line - added : undefined) };
}

function lines(text: string): number {
  let count = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) count++;
  return count;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Rejects after `ms`, so a page that never settles a promise cannot hold the check. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} took over ${ms / 1000} s`)), ms)));
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Render the page in `page` (a fresh one: the check leaves it changed) and report on it. */
export async function checkPage(page: Page, input: CheckInput, bridge: Bridge): Promise<CheckReport> {
  const viewport = VIEWPORTS[input.viewport];
  await page.setViewport(viewport);
  await page.exposeFunction("__piBridge", (request: BridgeRequest) => bridge(request));
  await page.setContent(HARNESS);
  const { document, mapLine } = renderForCheck(input.html);
  await inHarness(page, `window.__start(${JSON.stringify(document)}, ${JSON.stringify(input.manifest)})`);

  const started = Date.now();
  let state = { loaded: false, pending: 0 };
  for (;;) {
    await sleep(POLL_MS);
    const now = await inHarness<{ loaded: boolean; pending: number; idle: number }>(
      page,
      "({ loaded: __check.loaded, pending: __check.pending, idle: Date.now() - __check.active })",
    );
    state = now;
    const elapsed = Date.now() - started;
    if (elapsed >= MAX_MS || (now.loaded && now.pending === 0 && now.idle >= SETTLE_MS && elapsed >= MIN_MS)) break;
  }

  const frame = page.frames().find((f) => f !== page.mainFrame());
  const warnings: string[] = [];
  if (!state.loaded) warnings.push(`The page was still loading after ${MAX_MS / 1000} s.`);
  else if (state.pending > 0) warnings.push(`${state.pending} live call(s) were still running after ${MAX_MS / 1000} s.`);

  let height = viewport.height;
  let shown = { text: "", graphics: 0 };
  if (frame) {
    // Show the whole page, up to a limit, rather than its first screen.
    const scrollHeight = await frame.evaluate("document.documentElement.scrollHeight").catch(() => 0);
    const wanted = Math.min(Math.max(Number(scrollHeight) || 0, viewport.height), MAX_SHOT_HEIGHT);
    if (wanted > height) {
      height = wanted;
      await page.setViewport({ ...viewport, height });
      await sleep(300);
    }
    shown = await frame
      .evaluate(
        "({ text: document.body ? document.body.innerText : '', graphics: [...document.querySelectorAll('canvas,svg,img,video')].filter((e) => e.getBoundingClientRect().width > 0).length })",
      )
      .then((value) => value as typeof shown)
      .catch(() => shown);
  }
  const screenshot = await page.screenshot({ type: "jpeg", quality: 70, encoding: "base64" });
  const thumb = await page.screenshot({
    type: "jpeg",
    quality: 55,
    encoding: "base64",
    clip: { x: 0, y: 0, width: viewport.width, height, scale: Math.min(1, THUMB_WIDTH / viewport.width) },
  });

  const tests = frame ? await runTests(frame, input.tests) : input.tests.map((test) => ({ name: test.name, ok: false, detail: "The page did not load." }));
  // Errors the tests set off land a moment later.
  if (input.tests.length) await sleep(300);
  const harness = await inHarness<Pick<HarnessState, "log" | "calls" | "used">>(page, "({ log: __check.log, calls: __check.calls, used: __check.used })");

  return {
    ...judge({ ...harness, tests, shown, mapLine, manifest: input.manifest, warnings }),
    tests,
    text: clip(shown.text.trim(), MAX_TEXT),
    screenshot,
    thumb: `data:image/jpeg;base64,${thumb}`,
    width: viewport.width,
    height,
  };
}

async function runTests(frame: Frame, tests: readonly CheckTest[]): Promise<TestResult[]> {
  const results: TestResult[] = [];
  for (const test of tests) {
    try {
      // Evaluated through the devtools protocol: the page policy, which forbids eval, does not apply to it.
      const value = await within(frame.evaluate(`(async () => {\n${test.run}\n})()`), TEST_MS, "The test");
      if (value === false) results.push({ name: test.name, ok: false, detail: "returned false" });
      else results.push({ name: test.name, ok: true, detail: typeof value === "string" ? clip(value, MAX_ENTRY) : undefined });
    } catch (error) {
      results.push({ name: test.name, ok: false, detail: clip(error instanceof Error ? error.message : String(error), MAX_ENTRY) });
    }
  }
  return results;
}

interface Observed {
  log: HarnessState["log"];
  calls: HarnessState["calls"];
  used: boolean;
  tests: TestResult[];
  shown: { text: string; graphics: number };
  mapLine: (line: number) => number | undefined;
  manifest: ArtifactManifest;
  warnings: string[];
}

/** Sort what the check saw into errors and warnings. */
export function judge({ log, calls, used, tests, shown, mapLine, manifest, warnings }: Observed): Pick<CheckReport, "errors" | "warnings" | "calls"> {
  const errors: string[] = [];
  warnings = [...warnings];
  const failedOutside = calls.some((call) => !call.ok && call.code && OUTSIDE_THE_PAGE.has(call.code));

  const KINDS: Record<string, string> = {
    exception: "Uncaught",
    rejection: "Unhandled rejection:",
    error: "console.error:",
    warn: "console.warn:",
    resource: "",
    csp: "",
  };
  // A load the policy blocked also fails: say it once, as the policy's.
  const blocked = log.filter((e) => e.kind === "csp").map((e) => e.text.slice(e.text.indexOf("): ") + 3));
  const said = log.filter((e) => e.kind !== "resource" || !blocked.some((url) => e.text.endsWith(` ${url}`)));
  for (const [entry, count] of tally(said.map((e) => `${e.kind}\u0000${e.text}`))) {
    const [kind, raw] = entry.split("\u0000");
    const line = `${KINDS[kind] ?? kind} ${clip(pageLines(raw, mapLine), MAX_ENTRY)}`.trim() + (count > 1 ? ` (×${count})` : "");
    if (kind === "warn") warnings.push(line);
    // The page shows a call's failure as it should, and may log it: not the page's fault when the call failed outside it.
    else if (kind === "error" && failedOutside) warnings.push(`${line} (may come from the live calls that failed)`);
    else errors.push(line);
  }

  const summary = new Map<string, { ok: number; failed: Map<string, number> }>();
  for (const call of calls) {
    const key = `${call.server}/${call.tool}`;
    const entry = summary.get(key) ?? { ok: 0, failed: new Map() };
    summary.set(key, entry);
    if (call.ok) entry.ok++;
    else {
      const why = `${call.code}: ${clip(call.message ?? "", 300)}`;
      entry.failed.set(why, (entry.failed.get(why) ?? 0) + 1);
      const line = `Live call ${key} failed with ${why}`;
      if (call.code && OUTSIDE_THE_PAGE.has(call.code)) warnings.push(line);
      else errors.push(line);
    }
  }
  const callLines = [...summary].map(([key, { ok, failed }]) => {
    const parts = [ok && `${ok} ok`, ...[...failed].map(([why, n]) => `${n} failed (${why.split(":")[0]})`)].filter(Boolean);
    return `${key}: ${parts.join(", ")}`;
  });
  if ((manifest.mcp?.servers.length ?? 0) > 0 && !used) warnings.push("The page declares MCP tools but called none of them.");

  for (const test of tests) if (!test.ok) errors.push(`Test "${test.name}" failed: ${test.detail ?? "no reason given"}`);

  if (!shown.text.trim() && shown.graphics === 0) errors.push("The page shows nothing: no text and no canvas, svg or image.");
  for (const [line] of tally([...shown.text.matchAll(SCRIPT_ERROR_TEXT)].map((m) => m[0].trim()))) {
    errors.push(`The page shows a script error: "${clip(line, 300)}". Find what threw it (log caught errors with console.error to see where).`);
  }
  const suspects = tally([...shown.text.matchAll(SUSPECT_TEXT)].map((m) => m[0]));
  for (const [word, count] of suspects) warnings.push(`The page shows "${word}"${count > 1 ? ` ${count} times` : ""}: a value it rendered without having it?`);

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

/**
 * The report as the agent reads it: from the check tool, or from a publish that ran the check, where `published` says
 * what was published (nothing, when the check found errors).
 */
export function describeReport(report: CheckReport, published?: string): string {
  const { errors, warnings, calls, tests } = report;
  const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
  const passed = `The check passed${warnings.length ? ` with ${count(warnings.length, "warning")}` : ""}.`;
  let head: string;
  if (published === undefined)
    head = errors.length
      ? `The check found ${count(errors.length, "error")}. Fix them and check again; nothing was published.`
      : `${passed} Publish this exact page.`;
  else
    head = errors.length
      ? `Not published: the check found ${count(errors.length, "error")}. No version was made; fix them and publish again.`
      : `${published} ${passed}`;
  const parts = [
    head,
    errors.length && `Errors:\n${errors.map((e) => `- ${e}`).join("\n")}`,
    warnings.length && `Warnings:\n${warnings.map((w) => `- ${w}`).join("\n")}`,
    calls.length && `Live calls:\n${calls.map((c) => `- ${c}`).join("\n")}`,
    tests.length && `Tests:\n${tests.map((t) => `- ${t.ok ? "passed" : "FAILED"}: ${t.name}${t.detail ? ` (${t.detail})` : ""}`).join("\n")}`,
    `Visible text:\n${report.text || "(none)"}`,
    `Screenshot at ${report.width}×${report.height}: look at it for anything that renders wrong (overlaps, empty sections, broken charts, unreadable contrast).`,
  ];
  return parts.filter(Boolean).join("\n\n");
}
