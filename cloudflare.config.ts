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
    // Served only on this custom domain (its zone must be in the account), behind the Access app of ACCESS_TEAM_DOMAIN and
    // ACCESS_AUD below. workers.dev and Preview URLs stay off, so a deploy never reopens the Worker outside Access; both
    // are set explicitly, since cf leaves an unset previewUrls to the account's current setting. Another account changes
    // the domain along with those two (or drops it and sets workersDev: true).
    domains: ["pi.oxfer.app"],
    workersDev: false,
    previewUrls: false,
    // The React app. Everything the Worker answers itself is listed in
    // runWorkerFirst; any other path falls back to the SPA's index.html.
    assets: {
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*", "/u/*"],
    },
    env: {
      // New chats start on Auto (with a ROUTER_MODEL) until their user picks a model (worker/models.ts lists the
      // choices). MODEL at THINKING_LEVEL is what a chat runs on until Auto picks: a pi-ai Cloudflare AI Gateway
      // specifier, or a Workers AI id such as @cf/zai-org/glm-5.3-flash, and a pi thinking level.
      MODEL: bindings.text("anthropic/claude-sonnet-5.5"),
      THINKING_LEVEL: bindings.text("high"),
      // What names a chat after its first message: a small, fast model, as a pi-ai AI Gateway specifier or a Workers AI id.
      TITLE_MODEL: bindings.text("anthropic/claude-haiku-5.5"),
      // In a shared chat, a message that does not call the agent ("@pi") may still be meant for it ("pi, can you…"):
      // this System One classifier on Workers AI (worker/agent/call-hint.ts) says how likely, through the AI binding (no
      // provider key), and the author is offered to call the agent on it. Empty turns it off.
      CALL_HINT_MODEL: bindings.text("typesafe/jev"),
      // Auto, in the model picker: before each message that starts a run, a router model reads the end of the
      // conversation and the message, and picks one of AUTO_MODELS and an effort to answer it (worker/agent/route.ts).
      // ROUTER_MODEL: the router, a small, fast model; a comma-separated list is asked in order (the next one when one
      // fails, or beside it once it is slow; the first pick wins), with ROUTE_MS for all of them. If none answers,
      // the chat keeps its model.
      // decisions:<model> asks that OpenAI model through OpenAI's Decisions API, which picks without writing a reply
      // (input priced only), through AI Gateway with the OpenAI key; system-one:<model> asks a System One classifier on
      // Workers AI (typesafe/jev, @cf/cloudflare/clef-flash) the same way, through the AI binding. Workers AI runs on
      // Cloudflare's own network, with no provider key and no hop to another provider: Jev first, then gpt-oss-120b there,
      // then Gemini Flash-Lite with the Google AI Studio key. Empty (as with PI_OFFLINE=1, where no router can be reached):
      // no Auto for new chats, which start on MODEL.
      ROUTER_MODEL: bindings.text(
        process.env.PI_OFFLINE === "1" ? "" : "system-one:typesafe/jev,@cf/openai/gpt-oss-120b,google-ai-studio/gemini-flash-lite-latest",
      ),
      // The tool picker: before each message that starts a run, a System One classifier on Workers AI (by its id, as
      // CALL_HINT_MODEL; through the AI binding, no key) reads the end of the conversation and the message, and picks
      // the few MCP tools it needs; only those are offered to the model, which loads any other with tool_search
      // (worker/agent/tool-pick.ts). Fewer tool definitions per request, and fewer wrong calls. Only with more than 10 MCP tools; if it fails, every tool is
      // offered. Empty: every tool, always.
      TOOL_PICK_MODEL: bindings.text("typesafe/jev"),
      // Which skills the agent is shown: before each message that starts a run, this System One classifier on Workers AI
      // (by its id, as CALL_HINT_MODEL; through the AI binding) says which of the user's skills not shown in the chat yet the message
      // needs; only those join the ones shown (worker/agent/skill-pick.ts). Empty: every enabled skill, always.
      SKILLS_MODEL: bindings.text("typesafe/jev"),
      // The models Auto picks among, by the picker's id, each with what it is best at, which the router reads. Those the
      // picker does not list (no key in AI Gateway for their provider) are left out, as are those that cannot be called
      // (no credits, no access): each gets a tiny call whenever the providers are asked for their lists (worker/model-health.ts).
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
      // isolates; and, counted apart, each viewer's writes of pages' saved values. The namespace is any number unique within the account.
      PAGE_CALLS: bindings.rateLimit({ namespace: "4201", simple: { limit: 120, period: 60 } }),
      // What saved pages' model calls (pi.use("ai"): a viewer typing "put revenue first" into a dashboard) run on: a
      // comma-separated list of the picker's model ids, tried in order (worker/artifacts/page-ai.ts). gpt-oss-120b on
      // Workers AI needs no provider key; Gemini Flash-Lite, with the Google AI Studio key, answers when it fails.
      // Empty: pages have no model.
      PAGE_AI_MODEL: bindings.text("@cf/openai/gpt-oss-120b,google-ai-studio/gemini-flash-lite-latest"),
      // What one person's calls to pages' models may cost a day (UTC), in dollars: the person typing pays, not the
      // page's author. Counted in their UserDirectory.
      PAGE_AI_DAILY_USD: bindings.text("0.50"),
      // Calls to pages' models: 20 a minute per person.
      PAGE_AI: bindings.rateLimit({ namespace: "4202", simple: { limit: 20, period: 60 } }),
      // Dictation for browsers whose own speech recognition is missing (Firefox) or cannot reach its service (Brave,
      // Arc, a blocked network): the composer records the clip and a speech-to-text model on Workers AI, through the AI
      // binding, writes it out (worker/dictation.ts). Empty: no such fallback; the browser's own recognition only.
      DICTATION_MODEL: bindings.text(process.env.PI_OFFLINE === "1" ? "" : "@cf/openai/whisper-large-v3-turbo"),
      // How many minutes of audio one person may have transcribed a day (UTC); counted in their UserDirectory.
      DICTATION_DAILY_MINUTES: bindings.text("60"),
      // Clips sent for transcribing: 12 a minute per person.
      DICTATION: bindings.rateLimit({ namespace: "4203", simple: { limit: 12, period: 60 } }),
      // Headless Chrome (Browser Rendering): the agent checks each page in it before publishing (worker/artifacts/check.ts).
      // Local development runs a local Chrome, which miniflare downloads on first use.
      BROWSER: bindings.browser({ dev: { remote: false } }),
      // A vision classifier on Workers AI, run through the AI binding, looks at each check's screenshot and stops a page
      // it is sure renders blank or shows an error (worker/artifacts/look.ts): a System One model that sees images, by
      // its Workers AI id. Empty: checks go without it, as with PI_OFFLINE=1, where the AI binding cannot reach Workers AI.
      CHECK_LOOK_MODEL: bindings.text(process.env.PI_OFFLINE === "1" ? "" : "typesafe/jev"),
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
