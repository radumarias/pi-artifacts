import { bindings, defineConfig, defineContainer, exports } from "cf/config";
import { existsSync, readFileSync } from "node:fs";
import * as entrypoint from "./worker/index.ts" with { type: "cf-worker" };
import type { McpServerConfig } from "./worker/mcp/servers.ts";

// PI_NO_DOCKER=1 leaves out the sandbox container (and the run_python and run_bash tools), for machines without Docker.
const withSandbox = process.env.PI_NO_DOCKER !== "1";

/**
 * The MCP servers every chat connects to, as [{ name, url, auth?, cacheScope? }]. Each deployment keeps its own list out of the
 * repository: PI_MCP_SERVERS (JSON) if set, else mcp-servers.json (gitignored; see mcp-servers.example.json), else
 * only the public demo server.
 */
// Pick, not the interface itself: the JSON binding takes a mapped type, which has an implicit index signature.
function mcpServerList(): Pick<McpServerConfig, keyof McpServerConfig>[] {
  if (process.env.PI_MCP_SERVERS) return JSON.parse(process.env.PI_MCP_SERVERS);
  const file = new URL("./mcp-servers.json", import.meta.url);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  return [{ name: "CoinGecko", url: "https://mcp.api.coingecko.com/mcp" }];
}

// One Linux container per chat for run_python and run_bash. See Dockerfile.
const sandbox = defineContainer({
  name: "pi-artifacts-sandbox",
  schedulingPolicy: "durable-object",
  images: { sandbox: { dockerfile: "./Dockerfile" } },
});

export default defineConfig({
  worker: {
    name: "pi-artifacts",
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint,
    observability: { enabled: true },
    // The React app. Everything the Worker answers itself is listed in
    // runWorkerFirst; any other path falls back to the SPA's index.html.
    assets: {
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*", "/u/*"],
    },
    env: {
      // What new chats run on until their user picks a model (worker/models.ts lists the choices): a pi-ai Cloudflare
      // AI Gateway specifier, or a Workers AI id such as @cf/zai-org/glm-5.3-flash, and a pi thinking level.
      MODEL: bindings.text("anthropic/claude-opus-5.5"),
      THINKING_LEVEL: bindings.text("high"),
      // What names a chat after its first message: a small, fast model, as a pi-ai AI Gateway specifier or a Workers AI id.
      TITLE_MODEL: bindings.text("openai/gpt-4.1-nano"),
      // Auto, in the model picker: before each message that starts a run, a router model reads the end of the
      // conversation and the message, and picks one of AUTO_MODELS and an effort to answer it (worker/agent/route.ts).
      // ROUTER_MODEL: the router, a small, fast model; a comma-separated list is tried in order (the first the picker
      // lists answers; the next if it fails), with ROUTE_MS for all of them. If none answers, the chat keeps its model.
      ROUTER_MODEL: bindings.text("cerebras/gpt-oss-120b,openai/gpt-4.1-nano"),
      // The models Auto picks among, by the picker's id, each with what it is best at, which the router reads. Those the
      // picker does not list (no key in AI Gateway for their provider) are left out.
      AUTO_MODELS: bindings.json([
        { id: "anthropic/claude-opus-5.5", use: "the hardest work: large or intricate pages, debugging what failed, long multi-step tool use" },
        { id: "anthropic/claude-sonnet-5.5", use: "most page building and editing, data work, writing code" },
        { id: "anthropic/claude-haiku-5.5", use: "small edits, short answers, simple lookups with a tool or two" },
        { id: "openai/gpt-6.1-sol", use: "strong reasoning and code, an alternative for page building and analysis" },
        { id: "openai/gpt-6-luna", use: "cheap quick answers and light tool use" },
        { id: "google-ai-studio/gemini-pro-latest", use: "long documents and large attachments, analysis over a lot of text" },
        { id: "google-ai-studio/gemini-flash-latest", use: "fast, cheap answers that read images or long text" },
        { id: "cerebras/gpt-oss-120b", use: "very fast answers to simple questions; no images" },
      ]),
      AI_GATEWAY_ID: bindings.text("pi-artifacts"),
      // Alias of the provider keys stored in the gateway (Provider Keys), one each for Anthropic and OpenAI. Empty: the
      // keys aliased "default", else unified billing. Workers AI models need no key.
      AI_BYOK_ALIAS: bindings.text(""),
      SANDBOX_ENABLED: bindings.text(withSandbox ? "true" : "false"),
      // Who is signed in. "access" (the default, and the only mode to deploy): a verified Cloudflare Access token.
      // "demo" (AUTH_MODE=demo pnpm dev): a typed name in a cookie, for local development only.
      AUTH_MODE: bindings.text(process.env.AUTH_MODE === "demo" ? "demo" : "access"),
      ACCESS_TEAM_DOMAIN: bindings.text("xorio42.cloudflareaccess.com"),
      // The Access application's audience (AUD) tag, from Zero Trust → Access → Applications → pi-artifacts.
      ACCESS_AUD: bindings.text("21dcccf4fbfa5991beb76a9ac48ff0c0de86d3c1a55597c82e141559e3ebcdc9"),
      // 32+ random bytes, base64. Each user's files are encrypted with a key derived from it: losing it loses the files.
      FILES_MASTER_KEY: bindings.secret(),
      // DEV_TOOLS=true (when running pnpm dev) enables POST /api/dev/chats/:id/publish. Never set it for a deploy.
      DEV_TOOLS: bindings.text(process.env.DEV_TOOLS === "true" ? "true" : "false"),
      // The MCP servers every chat connects to: just a name and a URL each (see mcpServerList above). The agent learns
      // what a server offers from the server, and you name servers and tools in chat. "oauth": each user signs in, from
      // a link the agent gives. A Cloudflare MCP portal is one entry for every server behind it.
      MCP_SERVERS: bindings.json(mcpServerList()),
      // Live calls from published pages: 120 a minute per viewer and chat, counted by Cloudflare across the Worker's
      // isolates. The namespace is any number unique within the account.
      PAGE_CALLS: bindings.rateLimit({ namespace: "4201", simple: { limit: 120, period: 60 } }),
      // Headless Chrome (Browser Rendering): the agent checks each page in it before publishing (worker/artifacts/check.ts).
      // Local development runs a local Chrome, which miniflare downloads on first use.
      BROWSER: bindings.browser({ dev: { remote: false } }),
      // Workers AI binding. Pi's createAI() routes Claude through AI Gateway with it.
      AI: bindings.ai({}),
      // Each user's files (users/<uid>/files/…) and drafts (users/<uid>/drafts/<chatId>/…), and a read cache of artifact versions (artifacts/<id>/…).
      FILES: bindings.r2({ name: "pi-artifacts" }),
      // Cloudflare Artifacts: one Git repo per published artifact, the source of truth for its versions.
      // Local development uses a local Git backend, so it never touches the deployed repos.
      REPOS: bindings.artifacts({ namespace: "pi-artifacts", dev: { remote: false } }),
    },
    // The Worker reaches its own Durable Objects through `exports` from cloudflare:workers, not bindings.
    exports: {
      ChatAgent: exports.durableObject({ storage: "sqlite" }),
      UserDirectory: exports.durableObject({ storage: "sqlite" }),
      Sandbox: withSandbox ? exports.durableObject({ storage: "sqlite", container: sandbox }) : exports.durableObject({ storage: "sqlite" }),
    },
  },
  containers: withSandbox ? [sandbox] : [],
});
