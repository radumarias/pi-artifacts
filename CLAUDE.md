# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## pi-artifacts — working prototype

Claude-style artifacts on Cloudflare Workers: a Pi Durable agent (`agents/harness/pi`) per chat Durable Object builds
HTML dashboards, published as one Git repo each in Cloudflare Artifacts (R2 keeps a read cache) and previewed in a
sandboxed iframe. Pages get live data by calling `pi.use("mcp")`; calls go page → MessagePort → viewer page (`src/artifact/broker.ts`) → Worker → the chat's
`ChatAgent.artifactCall` → the same `McpHub` the agent's tools use. No model is involved in those calls. React + Vite
with `@cloudflare/vite-plugin`, pnpm; configured and deployed with the `cf` CLI (`cloudflare.config.ts`, no Wrangler config).

- `pnpm test` (hub, broker, Access tokens, storage rules; `LIVE=1` also hits CoinGecko), `pnpm typecheck`,
  `AUTH_MODE=demo pnpm dev`. Without a Cloudflare login or Docker: `AUTH_MODE=demo PI_OFFLINE=1 PI_NO_DOCKER=1 pnpm dev`. Everything but the model and the sandbox (`run_python`, `run_bash`) then works, and
  `POST /api/dev/chats/:id/publish` (with `DEV_TOOLS=true` in the environment) publishes a page without the model.
- `runtime/runtime.d.ts` is load-bearing twice: it documents the page API and is inlined into the agent's system
  prompt. Change it together with `runtime/pi-runtime.js`, `src/artifact/broker.ts` and `shared/protocol.ts`.
- Identity comes only from a verified Cloudflare Access token (`worker/auth/`). Only `worker/storage/` may touch the R2
  bucket or the Artifacts binding `REPOS` (a test enforces it); user files go through `UserFiles`, scoped per uid and
  encrypted with a per-user SSE-C key derived from the `FILES_MASTER_KEY` secret.
- MCP servers are only names and URLs, kept out of the repository: `PI_MCP_SERVERS` or the gitignored
  `mcp-servers.json` (see `mcp-servers.example.json`), read by `cloudflare.config.ts` into `MCP_SERVERS`. Keep the
  code and docs free of any one deployment's servers or business domain. The agent knows only what the servers say
  (tools, instructions), and the user names servers or tools in chat. `auth: "oauth"` entries (e.g. a Cloudflare MCP
  portal) sign in each user with a generic MCP OAuth client (`worker/mcp/oauth.ts`; tokens per
  user in `UserDirectory`; the agent hands out `/api/mcp/sign-in/<name>` links, routes in `worker/mcp-routes.ts`);
  pages calling them are author-only. `test/mcp-oauth.test.ts` runs the flow against a stand-in portal.
- Each artifact is the repo `artifact-<id>`: one commit and tag `v<n>` per publish, pushed with isomorphic-git
  (`worker/storage/git.ts`), since the binding cannot write files. `pnpm dev` uses a local Git backend for it (needs
  `git`); `test/artifact-store.test.ts` runs the real Git code against `git http-backend`.
- The README lists the security model (manifest per version, author's connections, write tools only for the author)
  and what has been verified in production (agent runs, `run_python`, per-user R2 encryption, artifact repos; the per-user
  MCP sign-in only locally).
- Deploy with `cf deploy` from the repository root (Worker `pi-artifacts` on workers.dev; R2 bucket, Artifacts namespace and AI
  Gateway all named `pi-artifacts`). The sandbox image build needs Docker.
