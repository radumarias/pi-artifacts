# pi-artifacts

A small reimplementation of Claude's artifacts on Cloudflare: chat with a [Pi](https://developers.cloudflare.com/agents/harnesses/pi/)
agent that builds **live dashboards**, preview them beside the chat, and share them by link. A published page pulls
**real-time data from MCP servers** each time someone views it, the way
[Claude's artifacts call MCP connectors](https://code.claude.com/docs/en/artifacts#pull-live-data-with-mcp-connectors).

- **Pi Durable** runs the agent inside a Durable Object, one per chat, and survives evictions mid-turn.
- **Durable Objects** hold each chat (agent, MCP connections, live calls) and each user's index of chats and artifacts.
- **Sandbox** (a Linux container per chat) runs the Python the agent writes, with no internet.
- **[Artifacts](https://developers.cloudflare.com/artifacts/)** keeps each published artifact as a Git repo: one commit
  and tag per version.
- **R2** keeps each user's files, which the agent reads and writes, plus a read cache of artifact versions.
- **The demo MCP server is [CoinGecko's public one](https://mcp.api.coingecko.com/mcp)**: free, keyless, live crypto market data.

![A live crypto dashboard artifact](docs/crypto-dashboard.png)

## How live data works

The page never talks to the network. Its CSP is `connect-src 'none'`. It calls `pi.use("mcp")`, and every call travels
to **the same MCP connection the agent used to build it**:

```
artifact page (sandboxed iframe, opaque origin)
  │  mcp.watchTool("CoinGecko", "execute", {code}, onEvent, {refetchInterval: 30_000})
  ▼  MessagePort, handed over once, in answer to the page's hello
viewer page: ArtifactBroker (src/artifact/broker.ts)
  │  caches, groups identical watches, pauses while the tab is hidden, polls on the server's hint
  ▼  POST /api/artifacts/:id/mcp  {version, mode, server, tool, input, staleMs}
Worker: finds the artifact's chat
  ▼  RPC
ChatAgent Durable Object (worker/chat-agent.ts)
  ├─ is (server, tool) in this version's manifest?      no → not_in_manifest
  ├─ read-only tool? cache + one shared request in flight (McpHub.read)
  ├─ a write? only the page's author may call it          no → not_granted
  └─ McpHub ─► MCP server (no model involved: deterministic, quick, no tokens)
```

**The manifest.** When the agent publishes, it declares the servers and tools the page may call
(`[{server: "CoinGecko", tools: ["execute"]}]`). Publishing checks those names against the server's real tool list and
refuses a mismatch. Each version keeps its own manifest; a page cannot widen it.

**Whose connection.** Calls use the chat's MCP connections, so they run as the page's author. Claude's artifacts use
each viewer's own connectors instead. Two things follow from that:

- Sharing a page shares the data its manifest allows.
- Tools that are not marked `readOnlyHint` are refused for everyone but the author, are never cached and cannot be
  watched.

CoinGecko needs no sign-in. A server can also require each user's own; see [MCP servers, and servers that need your own sign-in](#mcp-servers-and-servers-that-need-your-own-sign-in).

**Polling with a server hint.** Every response carries `nextRefreshAt`: when the Durable Object's copy goes stale.

- The viewer asks again 0.25–1.25 s after that time, so it shows a new upstream result within about a second of the
  Durable Object fetching it. That is as fresh as WebSocket push would be, without the sockets.
- `refetchInterval` has a 30 s floor, as at Claude.
- Each server's results are cached per viewer by default (`cacheScope: "viewer"` in `worker/mcp/servers.ts`, the way
  Claude keeps viewers apart). Switch a keyless server to `"shared"` to let every viewer reuse one upstream call per
  interval.
- A chat keeps at most 16 MB of cached results. Expired entries go first, then the oldest; a single result larger than
  that is passed on but not cached.
- Each viewer may make 120 calls a minute through the pages of one chat, counted by the Workers rate-limit binding `PAGE_CALLS`
  across every Worker instance. Past that the proxy answers `rate_limited`, and the viewer waits 30 s before asking again.

Measured against CoinGecko:

- One `execute` call takes 0.6–0.9 s.
- The prices it returns are already 18–32 s old.

So upstream freshness, not the transport, sets how live the page can be.

## MCP servers, and servers that need your own sign-in

The app is agnostic of what its MCP servers do. The server list is a list of names and URLs, nothing more, and each
deployment keeps its own out of the repository. `cloudflare.config.ts` reads it, in this order:
1. `PI_MCP_SERVERS`, as JSON, if set;
2. otherwise `mcp-servers.json`, which is gitignored (copy `mcp-servers.example.json`);
3. otherwise the public demo server alone.

```json
[
  { "name": "CoinGecko", "url": "https://mcp.api.coingecko.com/mcp" },
  { "name": "portal", "url": "https://mcp.example.com/mcp", "auth": "oauth" }
]
```

The last entry is a Cloudflare MCP portal.

- **What the agent knows** comes only from the servers: their tool lists, and the instructions a server sends when it
  connects. You say in chat which server or tools to use ("use the reports server's run_query for…"). Otherwise the agent picks by
  the tool descriptions.
- **A Cloudflare MCP portal is one entry** for every server behind it. Its tools come namespaced (`reports_run_query`),
  and its own `portal_*` tools are left in. Through them, the agent can list the portal's servers and turn them on,
  and the portal can answer with a link for signing in to one of them.

`auth: "oauth"` means each user signs in themselves, and their chats call with their own tokens. The app is a standard
MCP OAuth client for it (`worker/mcp/oauth.ts`, on the MCP SDK): discovery, dynamic client registration, PKCE and
refresh. There is nothing specific to any one server:

1. Until you sign in, the server's tools are missing. The agent's prompt names the server as unavailable, with a
   sign-in link such as `/api/mcp/sign-in/portal` (a path in this app, so it needs no knowledge of the app's address), and the agent passes the link on when you ask for it.
2. The link starts the flow and redirects to the server's sign-in. For a Cloudflare MCP portal, that means Cloudflare
   Access, then the portal's page where you select **Connect** for each server that needs your own login and sign in
   to its identity provider. The portal keeps those sessions; the app never sees them.
3. The browser comes back to `/api/mcp/oauth/callback`. The Worker checks the `state` against the sign-in it started
   for *you* (the callback needs your app session too), exchanges the code and stores your tokens. Ask again in the
   chat: your next prompt picks up the server's tools.

Where things live and who can use them:

- **Tokens are per user,** in your `UserDirectory` Durable Object, which only requests carrying your verified identity
  reach. All your chats share them.
- **When a sign-in lapses,** the SDK refreshes it. If it can't, calls fail with `auth_required`, and the message
  carries the sign-in link.
- **Two chats refreshing at once don't undo each other.** Each change to the stored record (new tokens, a cleared
  verifier) is applied inside the `UserDirectory` in one step, and a rejected refresh clears the tokens only if they
  are still the ones that chat used.
- **Pages that call such a server load only for people in their author's chat** (the author, and anyone they invited
  into it; see [Shared chats](#shared-chats)). A page calls through its author's chat, so it would otherwise show the
  author's data to anyone with the link. Other viewers get `not_granted`. Claude's artifacts instead use each viewer's
  own connectors.
- **Removing a server** from the list also removes everyone's stored sign-in for it, tokens included. This happens the
  next time each user's directory loads.
- **Signing out:** a new sign-in replaces your tokens once it finishes; starting one (anyone can link to the sign-in route) changes nothing until then. To end the portal's own session, sign out on the portal's home
  page.

`test/mcp-oauth.test.ts` runs the whole flow against a stand-in portal:
- a sign-in;
- two users kept apart;
- a forged `state` refused;
- refresh on expiry;
- `auth_required` when refresh fails, leaving an open sign-in untouched.

Locally, `PI_MCP_SERVERS='[…]' pnpm dev` uses another list, for example with a local stand-in portal.

Setting up a Cloudflare MCP portal for it (Zero Trust → Access controls → MCP Portals):

- The portal needs its own hostname, a subdomain of a zone in the account. On the bare domain of a site that already
  exists, `/mcp` reaches the site instead.
- The hostname needs a proxied CNAME to `gateway.agents.cloudflare.com`. The dashboard adds it when it creates a
  portal; changing the hostname later, the API and Terraform do not, and the portal's address then does not resolve.
- The portal's Access application and each of its servers' need an Allow policy listing who may use them. Without
  one, nobody can sign in.
- Keep **Require user auth** on for servers whose data depends on who asks: that is what makes each person sign in
  with their own account.
- Put the portal's `/mcp` address in `mcp-servers.json` with `"auth": "oauth"`.

## The page runtime

`runtime/pi-runtime.js` is inlined at the top of every published page. It mirrors the shape of Claude's
`window.claude.use("mcp")`, so a model that knows one writes the other. `runtime/runtime.d.ts` is the contract, and the
agent reads it in its system prompt.

```js
const mcp = await pi.use("mcp");                    // null outside a viewer: render a static fallback
const stop = mcp.watchTool("CoinGecko", "execute", { code }, (ev) => {
  if (ev.type === "data") render(ev.result.payload, ev.result.cache?.storedAt);
  else showSectionError(ev.error.code);             // server_unavailable, not_in_manifest, tool_error, …
}, { refetchInterval: 30_000 });

const docs = await mcp.CoinGecko.search_docs({ query: "markets" });   // one-shot call, resolves to the payload
await mcp.invalidate("CoinGecko");                                    // refetch now
```

[`examples/crypto-dashboard.html`](examples/crypto-dashboard.html) is a complete page written against it.

## Your files

Upload from the sidebar (several files, or a whole folder) or drop files and folders anywhere on the app. Uploads land
in `uploads/`, a folder keeping its layout (`reports/q3/sales.csv` is `uploads/reports/q3/sales.csv`); files and folders
whose names start with a dot (`.git`, `.DS_Store`) are left out of a folder. A file may be up to 10 MB; the app splits a
big pick into requests of at most 50 files and 40 MB (`shared/uploads.ts`, `worker/files-routes.ts`).

Before each message, the agent's prompt gets a list of your files, newest first (at most 150, then a count per folder),
so "the sales file from q3" maps to its path without a tool call. `files_read`, `run_python` and `run_bash` also take a
file's name or the end of its path when only one file matches, and answer with the candidates when several do
(`worker/agent/file-refs.ts`). The list changes the system prompt only when your files change.

## The sandbox

`run_python` and `run_bash` run in one Linux container per chat (`worker/sandbox.ts`, the Sandbox SDK's container
in a Durable Object). It runs Debian with Python 3.13, pandas, numpy and the usual command-line tools, and has no
internet. Each run is limited to 60 seconds. Files move like this:

- **In:** the agent names files from the user's files: paths, a file's name or the end of its path when only one file
  matches, or a folder for every file in it. The tool reads each one through the user's `UserFiles`, so R2 decrypts it
  with the user's key, and copies it into the container's `./files/` with the Sandbox SDK's file API, in its folders
  but without the leading `uploads/` (`uploads/q3/sales.csv` is `./files/q3/sales.csv`). Two files that would land on
  one path (`uploads/a.csv` and `a.csv`) refuse the run. One run takes at most 200 files and 25 MB (they reach the container in one RPC call, capped at 32 MiB).
- **Out:** after the run, whatever the script wrote to `./out/` (top level only) is read back from the container and
  saved through the same `UserFiles` as `out/<name>`, encrypted with the user's key.
- **Between runs:** `./files` and `./out` start empty each run. Anything else in the working directory stays until
  the container stops, 10 minutes after the last run.

The container never sees R2, the bucket or any key: only the bytes the Worker hands it.

## Skills

A skill tells the agent how to handle one kind of request: a **description** of when to use it, **instructions and
guardrails** to follow, and the **tools** it works with. Only the names and descriptions are in the system prompt; when
a request fits one, the agent calls `activate_skill` and gets the rest. Skills use the
[Agent Skills](https://agentskills.io) `SKILL.md` format (`name`, `description`, `allowed-tools`), served to Pi by
`skills()` from `agents/harness/pi`.

- **Built-in skills** ship as `SKILL.md` files in `worker/skills/builtin/`: `analyze-files` (questions about uploaded
  files, with `run_python`), `revise-artifact` (change a published page from its current version) and
  `explore-mcp-server` (learn a server with one small read-only call). Each user can turn them off.
- **Your own skills** are kept per user in `UserDirectory` and apply in all your chats. Write them, import a `SKILL.md`,
  download one, turn them on and off or delete them under **Skills** in the sidebar (`/skills`, API under
  `/api/skills`, in `worker/skills-routes.ts`). A change applies from the next message in any chat.
- **The agent can propose a skill** with `skill_propose` when you ask it to ("save this as a skill"). A proposal is
  saved **off** and can replace only another proposal that is still off. Text from a tool result or a file therefore
  never becomes standing instructions in every chat until you have read it and turned it on.
- Built-in and user skills are kept apart: each kind has its own names and API paths (`/api/skills/builtin/:name` and
  `/api/skills/:name`), and the list labels each skill's source. A new skill cannot take a built-in's name, but a
  built-in added later can take one of yours: then the agent uses yours while it is on, and the list says so.
- The tool list is guidance shown on activation, not a sandbox: every tool of the chat stays callable.

## Shared chats

A chat's owner can invite other people to build artifacts with them in the same chat. Pi Durable is multiplayer for
people: many people share one conversation with one agent, and their messages queue in its inbox while it works.

- **Invite:** **Share** in the chat header makes a single-use link, `/join/<token>`, valid for 7 days. The token names
  the chat and carries a random secret; the chat keeps only the secret's SHA-256 hash, so the link is shown once.
  Whoever opens it, signed in, clicks **Join** and finds the chat in their sidebar. The owner sees who is in the chat
  and the open links, removes people and revokes links; a member can leave. Only the owner invites.
- **One agent, acting as the owner:** a shared chat stays the owner's `ChatAgent`. Whoever writes, the agent works
  with the owner's MCP connections and sign-ins, files, sandbox and skills, and what it publishes belongs to the
  owner. The Share panel says so before the owner makes a link: members can ask it to read or change anything those
  reach.
- **Who wrote what:** each message is placed as a `chat.message` entry naming its author. Once the chat has members,
  the model reads it as `name: text` (before that, no name reaches the model), and a system-prompt section says who
  is in the chat.
- **Access:** the Worker finds the chat through the user's index (their own chats and the ones shared with them), and
  the chat object checks membership again on every socket and prompt, and on page calls to servers that sign in each
  user. Removing someone closes their sockets at once (close code 4403), and the app stops reconnecting.
- **Pages:** people in the chat may load its pages' data from servers that sign in each user, since they see that
  data in the conversation anyway. A page's write tools stay the author's only.
- Routes in `worker/chat-routes.ts`; members and invites in `worker/members.ts`, in the chat object's SQLite.

## Layout

| Path | What |
|---|---|
| `worker/index.ts`, `worker/files-routes.ts` | Routes: identity, chats, artifact pages (`/u/:id/v:n`), the rate-limited MCP proxy, files and uploads |
| `worker/chat-agent.ts` | `ChatAgent` DO: `PiHarness`, the chat socket (a capability on the Agents lifecycle API), `artifactCall`, members |
| `worker/chat-routes.ts`, `worker/members.ts` | Shared chats: the chat socket, people, invite links and their routes |
| `worker/mcp/`, `worker/mcp-routes.ts` | `McpHub` (connections, cache, coalescing, hint), the MCP SDK connector, the server list, per-user OAuth sign-in and its routes |
| `worker/agent/` | Pi tools (MCP, files, artifacts, `run_python`, `run_bash`, `skill_propose`), the system prompt, built-in skills |
| `worker/skills/`, `worker/skills-routes.ts` | Built-in skills, the SKILL.md format, and the `/api/skills` routes |
| `worker/artifacts/` | Manifest checks, the CSP and the runtime injection |
| `worker/auth/`, `worker/storage/` | Access token verification; the storage gatekeeper: artifact repos, per-user encrypted files |
| `cloudflare.config.ts` | The Worker, its bindings, Durable Object exports and the sandbox container (cf CLI) |
| `worker/users.ts`, `worker/sandbox.ts` | `UserDirectory` DO (chats, artifacts and skills per user), `Sandbox` DO (the container) |
| `runtime/` | The page runtime and its contract |
| `src/` | React app: chats, the streamed transcript, the preview panel, `ArtifactBroker`; resizable columns (`layout.tsx`); uploads and the file tree (`files/`) |
| `shared/` | Types and helpers used by all of the above |

## Run it

```sh
pnpm install
pnpm dev        # cf dev: needs a Cloudflare login (cf auth login; the AI binding is remote) and Docker (the sandbox)
```

- **Locally, sign in with a typed name:** `AUTH_MODE=demo pnpm dev`. Without it the app expects Cloudflare Access,
  which only exists once deployed.
- **Without a Cloudflare account or Docker:** run `AUTH_MODE=demo PI_OFFLINE=1 PI_NO_DOCKER=1 pnpm dev`. Everything
  works except the model and the sandbox (`run_python`, `run_bash`).
- **Testing live data without the model:** start with `DEV_TOOLS=true` added to the command above, which enables a
  publish route, then publish the example page into a chat:

  ```sh
  curl -c jar -X POST localhost:5173/api/session -H 'content-type: application/json' -d '{"name":"ada"}'
  CHAT=$(curl -s -b jar -X POST localhost:5173/api/chats | jq -r .id)
  jq -n --rawfile html examples/crypto-dashboard.html '{title:"Crypto pulse", html:$html, mcp:[{server:"CoinGecko",tools:["execute"]}]}' \
    | curl -s -b jar -X POST localhost:5173/api/dev/chats/$CHAT/publish -H 'content-type: application/json' -d @-
  # → {"artifactId":"…","version":1}; open http://localhost:5173/a/<artifactId>
  ```

Tests: `pnpm test` covers the hub, the broker, Access token checks and the storage rules (including a test that fails
if code outside `worker/storage/` touches the bucket). `LIVE=1 pnpm test` also calls CoinGecko. Typecheck with
`pnpm typecheck`.

## Deploy

The project uses Cloudflare's [`cf` CLI](https://developers.cloudflare.com/cf/); its configuration is
`cloudflare.config.ts`, migrated from Wrangler with `cf migrate`.

1. `cf auth login`. Add `--no-browser` on a remote machine: it prints a link and a code to approve.
2. Enable R2 for the account in the dashboard, then create the bucket: `cf r2 buckets create --name pi-artifacts`.
   The Artifacts namespace `pi-artifacts` needs no setup: it is created with the first repo. Artifacts needs the
   Workers Paid plan.
3. Create an AI Gateway named `pi-artifacts` and store an Anthropic key in it (BYOK), or use unified billing.
   `MODEL` in `cloudflare.config.ts` is a pi-ai gateway specifier (`anthropic/claude-sonnet-5.5`). A Workers AI id
   such as `@cf/zai-org/glm-5.3-flash` needs no key.
4. Put the app behind Cloudflare Access: create a self-hosted Access application for the Worker's hostname with a
   policy listing who may sign in, then set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` (the application's audience tag) in
   `cloudflare.config.ts`.
5. Generate the file-encryption master key (`openssl rand -base64 32`, at least 32 bytes) and keep a copy somewhere
   safe: losing it makes every user's files unreadable, and changing it later needs a migration (see
   [How file encryption works](#how-file-encryption-works)). Pass it as a secret:
   `cf deploy --secrets-file secrets.json` with `{"FILES_MASTER_KEY": "…"}`, then delete `secrets.json`. Later deploys
   keep the secret, so they need no `--secrets-file` unless it changes.
6. `pnpm run deploy` (`cf deploy`). This builds the sandbox image with Docker and needs the Workers Paid plan.

## Who can read what

- **Sign-in:** Cloudflare Access lets only the people in its policy reach the app at all. The Worker then verifies the
  token Access signs (signature against the team's keys, issuer, audience, expiry) and derives the user's id from it.
  The id never comes from the browser or the model.
- **One gatekeeper for storage:** only `worker/storage/` touches the R2 bucket or the Artifacts binding, and a test
  enforces it. Everything else gets either the artifact store or a `UserFiles` handle scoped to one user, which builds
  every key under that user's folder and rejects paths like `..` or absolute paths.
- **Per-user encryption:** user files are stored with R2 customer-supplied keys (SSE-C), one key per user. See
  [How file encryption works](#how-file-encryption-works).
- **Artifacts** are shared by link with anyone Access lets in, and are not encrypted per user. Only their owner's chat
  can publish new versions, and only their owner can clone their repo. See
  [Versions in Git](#versions-in-git).
- **Shared chats** open only to their owner and the people the owner invited, and everyone in one works through the
  owner's agent and connections. See [Shared chats](#shared-chats).

### Versions in Git

Each published artifact is a repo, `artifact-<id>`, in the Cloudflare Artifacts namespace `pi-artifacts`
(`worker/storage/artifacts.ts`).

- **Each publish is one commit, tagged `v<n>`.** The commit holds `index.html` and `artifact.json`: the metadata and
  every version's manifest. The agent passes a one-line `message`, which becomes the commit message (`v3: Add a 7-day
  sparkline`).
- **The repo is the source of truth; R2 is a read cache.** A publish writes each new version and the latest metadata
  to R2 too, so page views and live calls never touch Git. If the cache is missing something, it is read back from
  the repo and the cache is filled again.
- **Pushing from a Worker.** The Artifacts binding manages repos and reads files, but it cannot write them. A publish
  therefore uses [isomorphic-git](https://isomorphic-git.org/) on an in-memory filesystem: a depth-1 clone, one
  commit, then a push of `main` and of the tag.
- **The agent can see its history.** `artifact_history` lists the versions with their messages, and `artifact_diff`
  shows a unified diff of the page between two of them.
- **Older artifacts.** An artifact published before repos existed has only its R2 copy. It keeps serving from there,
  and the first new publish replays its versions into a new repo, one commit each with their original dates.

How users stay apart:

- **The binding is not per user.** `env.REPOS` can open every repo in the namespace, and Artifacts knows nothing about
  our users. Only `worker/storage/` may use it, and repo names come only from artifact ids whose owner the Worker
  has checked against the verified Access identity.
- **Git tokens are scoped to one repo, and short-lived.** Each publish mints a 5-minute write token for that one repo
  and revokes it after the push, along with the day-long token `create()` returns.
- **Owners can clone.** The preview's `git` button calls `POST /api/artifacts/:id/clone`, which only the owner may
  call. It returns a read-only token for that one repo, valid for 15 minutes, as a ready `git clone` command. Pushing
  with it is refused.
- **No per-user encryption here.** Artifacts are already shared by link, so nothing is lost. Private user files stay in
  R2 under per-user keys; see below.

Locally, `cloudflare.config.ts` points `REPOS` at a local Git backend (`dev: {remote: false}`, which needs `git`
installed), so development never touches the deployed repos. `test/artifact-store.test.ts` runs the store's real Git
code against `git http-backend`.

### How file encryption works

The master key never encrypts anything itself. It only derives each user's key, and R2 encrypts with that key.

```
Access token (verified) → sub
uid     = first 32 hex chars of SHA-256("<team domain>:" + sub)                  worker/auth/index.ts
userKey = HKDF-SHA-256(ikm = FILES_MASTER_KEY,                                   worker/storage/keys.ts
                       salt = "pi-artifacts/user-files/v1", info = uid) → 256 bits
UserFiles(uid, userKey): keys under users/<uid>/files/, every put/get passes {ssecKey: userKey}
                                                                                  worker/storage/user-files.ts
```

- **No key is stored.** The derivation is deterministic, so a user's key is recomputed whenever their files are
  opened.
- **R2 encrypts with AES-256 and keeps only a fingerprint of the key.** A read without the key, or with another user's
  key, is refused.
- **A leaked user key reveals neither the master key nor anyone else's key.** HKDF is one-way.
- **Two independent locks.** The path prefix is one and the key is the other. A prefix bug, or someone with only an R2
  API token or the dashboard, can see objects but not read them.

What it does not cover:

- **It is not end-to-end encryption.** The Worker holds the master key, so it can derive any user's key, and it must, so
  the agent can read your files for you. Anyone who can deploy this Worker or read its secrets can read every file.
- **Metadata is visible.** Only file contents are encrypted. Object names (file paths), sizes, upload times and content
  types are not.
- **Losing the master key loses every file.** Changing it is a migration: read each file with the old key and write it
  back with the new one. The `v1` in the salt leaves room for a second scheme during such a migration.
- **The local R2 simulator ignores SSE-C.** In `AUTH_MODE=demo` a fixed demo key stands in for the master key, and
  files are stored unencrypted. A deployed Worker without `FILES_MASTER_KEY` refuses all file access.

Artifact pages are served from the app's own origin inside an opaque-origin sandbox: the viewer frames them with
`sandbox`, and their CSP carries a `sandbox` directive too, so a page opened directly or as a popup is just as
isolated. That is enough to keep them away from the app's cookies and storage. A production deployment should still serve `/u/*` from a separate domain, as
claude.ai uses `*.claudeusercontent.com`.

A published version never changes, so its page carries an `ETag` (artifact, version, and a fingerprint of the runtime
and CSP) and `Cache-Control: private, no-cache`. The browser revalidates on every load, and the Worker answers `304`
before reading R2. Changing the runtime or the CSP changes the fingerprint, so a deploy is picked up at once.

## Limits and what's next

- **Access policy is per email.** Adding people means adding them to the Access policy. Per-viewer consent for live
  data (as in Claude's artifacts) is not built yet.
- **Verified deployed with Claude Sonnet 5.5:** the agent built a live BTC/ETH/SOL dashboard from one prompt and, when
  told what was wrong, fixed it as version 2 of the same artifact.

  ![A dashboard the deployed agent built](docs/agent-dashboard.png)

  Also verified deployed:
  - `run_python` wrote a file into the user's files;
  - R2 refuses to read that file without its key ("stored using a form of Server Side Encryption");
  - a publish created the artifact's repo, and its `git` button produced a working clone command.

  The per-user sign-in to an MCP portal has been verified only locally, against a stand-in portal: the deployed
  portal so far refuses the code exchange with Cloudflare error 1014 (see
  [MCP servers, and servers that need your own sign-in](#mcp-servers-and-servers-that-need-your-own-sign-in)).
- **Pi Durable is experimental.** It has no tool approvals, conversations can't be deleted yet, and a reconnecting
  client resumes from a fresh snapshot rather than a cursor.
- **Next:**
  - a screenshot self-check in the sandbox before publishing
  - live data from sign-in servers for every viewer, each with their own sign-in
  - in shared chats, members bringing their own files and sign-ins to the agent
  - WebSocket push for sources that stream
  - a separate preview domain

## License

MIT; see [LICENSE](LICENSE).
