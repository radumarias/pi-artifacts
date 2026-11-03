import puppeteer, { type Browser } from "@cloudflare/puppeteer";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deadline } from "../shared/util.ts";
import { CheckTimedOut } from "../worker/artifacts/browser.ts";
import { checkPage, describeReport, renderForCheck, type Bridge, type BridgeRequest, type CheckInput } from "../worker/artifacts/check.ts";

/** A local Chrome to check pages in: CHROME_PATH, else the one Playwright installs. Without one the browser tests skip. */
function chromePath(): string | undefined {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = "/opt/pw-browsers";
  if (!existsSync(root)) return undefined;
  for (const dir of readdirSync(root).filter((d) => /^chromium-\d+$/.test(d))) {
    const path = `${root}/${dir}/chrome-linux64/chrome`;
    if (existsSync(path)) return path;
  }
  return undefined;
}

describe("renderForCheck", () => {
  it("maps the rendered document's lines back to the page's", () => {
    const html = "<!doctype html>\n<html>\n<head>\n<title>t</title>\n</head>\n<body>\n<script>boom()</script>\n</body>\n</html>";
    const { document, mapLine } = renderForCheck(html);
    const lines = document.split("\n");
    const boom = lines.findIndex((line) => line.includes("boom()")) + 1;
    expect(mapLine(boom)).toBe(7);
    expect(mapLine(1)).toBe(1);
    // A line of the runtime is nobody's page line.
    expect(mapLine(4)).toBeUndefined();
  });

  it("maps a fragment's first line to 1", () => {
    const { document, mapLine } = renderForCheck("<p>one</p>\n<script>two()</script>");
    const two = document.split("\n").findIndex((line) => line.includes("two()")) + 1;
    expect(mapLine(two)).toBe(2);
    expect(mapLine(two - 1)).toBe(1);
  });

  it("puts the page policy and the capture script before the runtime", () => {
    const { document } = renderForCheck("<p>hi</p>");
    const policy = document.indexOf('http-equiv="Content-Security-Policy"');
    const capture = document.indexOf("pi:check");
    const runtime = document.indexOf("window.pi");
    expect(policy).toBeGreaterThan(0);
    expect(capture).toBeGreaterThan(policy);
    expect(runtime).toBeGreaterThan(capture);
    expect(document).toContain("connect-src 'none'");
    expect(document).not.toMatch(/content="sandbox/);
  });
});

const chrome = chromePath();

describe.skipIf(!chrome)("checkPage in Chrome", () => {
  let process: ChildProcess;
  let browser: Browser;

  beforeAll(async () => {
    process = spawn(chrome!, ["--headless=new", "--no-sandbox", "--remote-debugging-port=0", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
    const endpoint = await new Promise<string>((resolve, reject) => {
      let output = "";
      process.stderr!.on("data", (chunk) => {
        output += chunk;
        const found = output.match(/ws:\/\/\S+/);
        if (found) resolve(found[0]);
      });
      process.on("exit", () => reject(new Error(`Chrome exited: ${output}`)));
    });
    browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
  }, 30_000);

  afterAll(async () => {
    await browser?.disconnect().catch(() => {});
    process?.kill();
  });

  const QUOTES = { mcp: { servers: [{ server: "Demo", tools: ["quotes"] }] } };
  const quotes: Bridge = async (request) =>
    request.method === "call"
      ? {
          ok: true,
          result: {
            content: [],
            payload: {
              quotes: [
                { symbol: "ABC", price: 12.5 },
                { symbol: "XYZ", price: 3 },
              ],
            },
          },
        }
      : { ok: true, tool: { name: "quotes", description: "Quotes" } };

  async function check(html: string, options: Partial<CheckInput> = {}, bridge: Bridge = quotes) {
    const page = await browser.newPage();
    try {
      return await checkPage(page, { html, manifest: QUOTES, tests: [], viewport: "desktop", ...options }, bridge);
    } finally {
      await page.close();
    }
  }

  const LIVE_PAGE = `<!doctype html><html><head><title>Quotes</title></head><body>
<h1>Quotes</h1>
<table id="quotes"><tbody></tbody></table>
<script>
pi.use("mcp").then((mcp) => {
  mcp.watchTool("Demo", "quotes", {}, (event) => {
    if (event.type !== "data") return console.error(event.error);
    document.querySelector("#quotes tbody").innerHTML = event.result.payload.quotes.map((q) => "<tr><td>" + q.symbol + "</td><td>" + q.price + "</td></tr>").join("");
  });
});
</script></body></html>`;

  it("passes a page that renders its live data, and runs its tests", async () => {
    const calls: BridgeRequest[] = [];
    const report = await check(
      LIVE_PAGE,
      {
        tests: [
          { name: "rows", run: "const n = document.querySelectorAll('#quotes tr').length; if (n !== 2) throw new Error(n + ' rows'); return n + ' rows';" },
          { name: "title", run: "return document.querySelector('h1').textContent === 'Quotes';" },
        ],
      },
      async (request) => (calls.push(request), quotes(request)),
    );
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.tests).toEqual([
      { name: "rows", ok: true, detail: "2 rows" },
      { name: "title", ok: true, detail: undefined },
    ]);
    expect(report.calls).toEqual(["Demo/quotes: 1 ok"]);
    expect(calls).toEqual([{ method: "call", mode: "read", server: "Demo", tool: "quotes", input: {} }]);
    expect(report.text).toContain("ABC");
    expect(report.screenshot.length).toBeGreaterThan(1_000);
    expect(report.thumb).toMatch(/^data:image\/jpeg;base64,/);
    expect(describeReport(report)).toMatch(/^Live calls:\n- Demo\/quotes: 1 ok\n\nTests:\n- passed: rows \(2 rows\)\n- passed: title\n\nVisible text:\nQuotes/);
  }, 30_000);

  it("reports an uncaught exception with the page's own line", async () => {
    const report = await check("<!doctype html><html><head></head><body>\n<p>Map</p>\n<script>\nconst L = {};\nL.map('map');\n</script></body></html>", {
      manifest: {},
    });
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatch(/^Uncaught TypeError: L\.map is not a function/);
    expect(report.errors[0]).toContain("page line 5:");
    expect(describeReport(report)).toMatch(/^Errors:\n- Uncaught TypeError: L\.map is not a function/);
  }, 30_000);

  it("reports an error the page caught and logged, rejections, and what the policy blocked", async () => {
    const report = await check(
      `<p>Hi</p><script>
try { null.x } catch (e) { console.error("load failed", e) }
fetch("https://example.com/data.json");
</script><img src="https://example.com/logo.png">`,
      { manifest: {} },
    );
    expect(report.errors.some((e) => e.startsWith("console.error: load failed TypeError"))).toBe(true);
    expect(report.errors.some((e) => e.startsWith("Unhandled rejection:"))).toBe(true);
    expect(report.errors.some((e) => e.includes("(connect-src): https://example.com/data.json"))).toBe(true);
    expect(report.errors.some((e) => e.includes("(img-src): https://example.com/logo.png"))).toBe(true);
    // The load the policy blocked is reported once, as the policy's.
    expect(report.errors.some((e) => e.startsWith("Failed to load"))).toBe(false);
  }, 30_000);

  it("reports a script error the page caught and only showed", async () => {
    const report = await check(
      `<link rel="stylesheet" href="https://example.com/map.css"><div id="err"></div><script>try { const L = {}; L.map("map") } catch (e) { document.getElementById("err").textContent = e.message }</script>`,
      { manifest: {} },
    );
    expect(report.errors).toEqual([
      "Blocked by the page policy (style-src-elem): https://example.com/map.css",
      'The page shows a script error: "L.map is not a function". Find what threw it (log caught errors with console.error to see where).',
    ]);
  }, 30_000);

  it("fails a test that throws, returns false or does not parse", async () => {
    const report = await check(LIVE_PAGE, {
      tests: [
        { name: "chart", run: "if (!document.querySelector('canvas')) throw new Error('no chart');" },
        { name: "false", run: "return false;" },
        { name: "broken", run: "return (;" },
      ],
    });
    expect(report.tests.map((t) => [t.name, t.ok])).toEqual([
      ["chart", false],
      ["false", false],
      ["broken", false],
    ]);
    expect(report.tests[0].detail).toContain("no chart");
    expect(report.errors).toContain('Test "chart" failed: no chart');
    expect(report.errors).toContain('Test "false" failed: returned false');
  }, 30_000);

  it("only warns when a call fails outside the page, and the page logs it", async () => {
    const report = await check(LIVE_PAGE, {}, async (request) =>
      request.method === "call" ? { ok: false, error: { code: "auth_required", server: "Demo", message: "Sign in first." } } : quotes(request),
    );
    expect(report.errors).toEqual([]);
    expect(report.warnings).toContain("Live call Demo/quotes failed with auth_required: Sign in first.");
    expect(report.warnings.some((w) => w.startsWith("console.error:") && w.endsWith("(may come from the live calls that failed)"))).toBe(true);
    expect(report.calls).toEqual(["Demo/quotes: 1 failed (auth_required)"]);
  }, 30_000);

  it("gives a syntax error the page's own line", async () => {
    const report = await check("<!doctype html><html><head></head><body>\n<p>x</p>\n<script>\nconst a = 1;\nfunction ( {\n</script></body></html>", {
      manifest: {},
    });
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatch(/^Uncaught SyntaxError: .*page line 5:/);
  }, 30_000);

  it("keeps a script error the page logged an error when a call failed outside it", async () => {
    const report = await check(
      `<p>x</p><script>pi.use("mcp").then(async (mcp) => { await mcp.callTool("Demo", "quotes", {}).catch((e) => console.error(e)); try { null.x } catch (e) { console.error("bug", e) } })</script>`,
      {},
      async () => ({ ok: false, error: { code: "not_granted", server: "Demo", message: "Not run in the check." } }),
    );
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatch(/^console\.error: bug TypeError/);
    expect(report.warnings.some((w) => w.endsWith("(may come from the live calls that failed)"))).toBe(true);
  }, 30_000);

  it("says a call that fails alike again and again once", async () => {
    const report = await check(
      `<p>x</p><script>pi.use("mcp").then(async (mcp) => { for (let i = 0; i < 20; i++) await mcp.callTool("Demo", "quotes", { i }).catch(() => {}) })</script>`,
      {},
      async () => ({ ok: false, error: { code: "bad_request", server: "Demo", message: "Bad input." } }),
    );
    expect(report.errors).toEqual(["Live call Demo/quotes failed with bad_request: Bad input. (×20)"]);
  }, 30_000);

  it("reports a call the page got wrong as an error", async () => {
    const report = await check(
      `<p>x</p><script>pi.use("mcp").then((mcp) => mcp.callTool("Demo", "secret", {}).catch((e) => document.body.append(e.code)))</script>`,
      {},
      async () => ({ ok: false, error: { code: "not_in_manifest", server: "Demo", message: "This page does not declare Demo/secret." } }),
    );
    expect(report.errors).toEqual(["Live call Demo/secret failed with not_in_manifest: This page does not declare Demo/secret."]);
    expect(report.text).toContain("not_in_manifest");
  }, 30_000);

  it("reports a page that shows nothing, and text that looks like a missing value", async () => {
    expect((await check("<div></div>", { manifest: {} })).errors).toEqual(["The page shows nothing: no text and no canvas, svg or image."]);
    const report = await check("<p>Price: NaN</p><p>undefined</p>", { manifest: {} });
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([
      'The page shows "NaN": a value it rendered without having it?',
      'The page shows "undefined": a value it rendered without having it?',
    ]);
  }, 30_000);

  it("warns when a page declares tools but never asks for them", async () => {
    const report = await check("<p>Static</p>");
    expect(report.warnings).toContain("The page declares MCP tools but called none of them.");
  }, 30_000);

  it("screenshots a long page whole, up to a limit", async () => {
    const report = await check(`<div style="height:1800px;background:linear-gradient(red,blue)">Tall</div>`, { manifest: {} });
    expect(report.height).toBeGreaterThan(1_800);
    expect(report.height).toBeLessThanOrEqual(2_400);
    const mobile = await check("<p>Small</p>", { manifest: {}, viewport: "mobile" });
    expect([mobile.width, mobile.height]).toEqual([390, 844]);
  }, 30_000);

  it("cannot finish on a page that never yields, so the deadline around it has to end it", async () => {
    const page = await browser.newPage();
    const spin = `<p>Spins</p><script>setTimeout(() => { for (;;) {} }, 50);</script>`;
    const started = Date.now();
    const checking = checkPage(page, { html: spin, manifest: {} }, quotes);
    checking.catch(() => {});
    await expect(deadline(checking, 4_000, () => new CheckTimedOut("the check did not finish in 4 s"))).rejects.toBeInstanceOf(CheckTimedOut);
    expect(Date.now() - started).toBeLessThan(6_000);
    // The renderer is stuck: what the check browser does then is drop the page without waiting on it.
    void page.close().catch(() => {});
  }, 30_000);
});
