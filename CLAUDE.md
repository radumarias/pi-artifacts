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
  prompt. Change it together with `runtime/pi-runtime.js`, `src/artifact/broker.ts`, `shared/protocol.ts` and the
  check's harness, which plays the viewer's part in short (`HARNESS` in `worker/artifacts/check.ts`).
- Identity comes only from a verified Cloudflare Access token (`worker/auth/`). Only `worker/storage/` may touch the R2
  bucket or the Artifacts binding `REPOS` (a test enforces it); user files go through `UserFiles`, scoped per uid and
  encrypted with a per-user SSE-C key derived from the `FILES_MASTER_KEY` secret.
- MCP servers are only names and URLs, kept out of the repository: `PI_MCP_SERVERS` or the gitignored
  `mcp-servers.json` (see `mcp-servers.example.json`), read by `cloudflare.config.ts` into `MCP_SERVERS`. Keep the
  code and docs free of any one deployment's servers or business domain. The agent knows only what the servers say
  (tools, instructions), and the user names servers or tools in chat. `auth: "oauth"` entries (e.g. a Cloudflare MCP
  portal) sign in each user with a generic MCP OAuth client (`worker/mcp/oauth.ts`; tokens per
  user in `UserDirectory`; the agent hands out `/api/mcp/sign-in/<name>` links, routes in `worker/mcp-routes.ts`);
  pages calling them load only for people in the author's chat. `test/mcp-oauth.test.ts` runs the flow against a stand-in portal.
- Skills (`shared/skills.ts`, `worker/skills/`, `worker/agent/skills.ts`): built-in `SKILL.md` files in `worker/skills/builtin/` plus each
  user's own, stored in `UserDirectory` and installed through `skills()` from `agents/harness/pi` before every prompt.
  A skill the agent proposes (`skill_propose`) is saved off until the user turns it on; keep it that way. With
  `SKILLS_MODEL` set, Jev (Workers AI) picks which skills a message needs (`worker/agent/skill-pick.ts`); a chat's list
  only grows, so the prompt cache holds, and a failed pick lists them all.
- Shared chats (`worker/chat-routes.ts`, `worker/members.ts`): the owner invites people by single-use link; they share
  the one conversation and the one agent, which always acts as the owner (owner's MCP sign-ins, files, skills; artifacts
  owned by the owner). The chat object checks membership on every socket and prompt; keep it that way. Once a chat
  has members, the agent (named `pi`) runs only for a message with `@pi` or a reply to it (`summonsAgent`); other
  messages are asides the model reads as context (`chat.aside` writes). `@name` tags a person in the chat: they get a
  notice over their sidebar socket (a `Tag` on `UserDirectory.touchChat`/`touchSharedChat`), and a browser notification when allowed. Members see and name only the chat's files
  and artifacts of the owner's (`ChatAgent.chatFiles`, `contents`), plus their own files.
- Before a page becomes a version it is checked in a headless browser (`BROWSER` binding, `worker/artifacts/check.ts`):
  the agent saves a page with `artifact_write` (then changes it only by edits), and `artifact_check` and `artifact_publish` take it by draft id and report console errors, failed calls, a screenshot and the agent's tests, and
  publish refuses a page with errors, or one no browser checked (except with `AUTH_MODE=demo`); keep it that way. Until
  then a page is a draft, in the owner's R2 folder (`worker/storage/drafts.ts`, `ChatDrafts`), never a commit. `test/check.test.ts` runs the check in a local Chrome
  (`CHROME_PATH`, else Playwright's) and skips without one.
- Each artifact is the repo `artifact-<id>`: one commit and tag `v<n>` per publish, pushed with isomorphic-git
  (`worker/storage/git.ts`), since the binding cannot write files. `pnpm dev` uses a local Git backend for it (needs
  `git`); `test/artifact-store.test.ts` runs the real Git code against `git http-backend`. Shared test doubles (R2 bucket, local
  server) live in `test/fakes.ts`.
- The README lists the security model (manifest per version, author's connections, write tools only for the author)
  and what has been verified in production (agent runs, `run_python`, per-user R2 encryption, artifact repos; the per-user
  MCP sign-in only locally).
- Screenshots and other media for docs and pull requests go in `docs/media/<feature>/`, which Git LFS stores
  (`.gitattributes`). Link them from a PR as `https://github.com/radumarias/pi-artifacts/raw/<commit>/docs/media/…`:
  raw.githubusercontent.com serves only the LFS pointer.
- Deploy with `cf deploy` from the repository root (Worker `pi-artifacts` on workers.dev; R2 bucket, Artifacts namespace and AI
  Gateway all named `pi-artifacts`). The sandbox image build needs Docker.
