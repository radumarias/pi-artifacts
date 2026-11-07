import { signInNoticeText, type McpSignInView, type SignInNotice, type SignInNoticeKind } from "../../shared/sign-ins.ts";
import { errorMessage, serial } from "../../shared/util.ts";
import { addColumns, type Sql } from "../members.ts";
import { checkSignIn, grantMs, KEEP_ALIVE_MS, KEEP_ALIVE_RETRY_MS, warnAt, type SignInCheck } from "./background.ts";
import { applyAuthChange, signInPath, type McpAuthChange, type McpAuthRecord, type McpAuthStore } from "./oauth.ts";
import { openAuthRecord, sealAuthRecord } from "./sealed.ts";
import { mcpServers, oauthServers, type McpServerConfig } from "./servers.ts";

/** What a row holds besides the sealed record. Signed in = `signed_in_at` is set (there are tokens). */
type AuthRow = { server: string; signed_in_at: number | null; warned_at: number; keep_at: number };

/** A check before a run trusts a refresh this recent instead of refreshing again (and rotating the refresh token). */
export const RECENT_REFRESH_MS = 60 * 60 * 1000;

/** What the sign-ins need from the UserDirectory they live in. */
export interface SignInsHost {
  sql: Sql;
  env: { MCP_SERVERS?: unknown; MCP_GRANT_DAYS?: unknown };
  /** The user's key for their sign-in records (mcpTokensKey). */
  key: () => Promise<CryptoKey>;
  /** The list of sign-ins changed: open sidebars read it again. */
  changed: () => void;
  /** Tell the user: the sidebar's socket (open apps read the list again), and a push. */
  notify: (notice: SignInNotice, push: { title: string; body: string; url: string; tag: string }) => Promise<void>;
  /** The user signed in to `server` again: tell one of their chats with runs waiting on it (ChatAgent.signedIn). */
  signedIn: (chatId: string, server: string) => Promise<void>;
  /** When the next warning or keep-alive is due; null for none. Called only when it changes. */
  setAlarm: (at: number | null) => void;
  /** Tests pass a check and a clock. */
  check?: (server: McpServerConfig, store: McpAuthStore) => Promise<SignInCheck>;
  now?: () => number;
}

/** What a run's need for a sign-in says: the chat whose runs wait, what waits, and whether to tell the user. */
export type SignInNeededContext = {
  chatId?: string;
  what?: string;
  quiet?: boolean;
  /** The agent reads the server in a step: going on without it is no way out, so Disconnect is not offered for it. */
  stepReads?: boolean;
};

/**
 * One user's sign-ins to servers that sign in each user, in their UserDirectory's SQLite:
 *
 * - `mcp_auth`: one row per server, the record (client registration, tokens, a sign-in in progress) sealed with the
 *   user's key (worker/mcp/sealed.ts), beside what needs no secret: when the grant started (null without tokens), the
 *   grant it already warned about (by its start), and when the next keep-alive refresh is due. A row written before
 *   encryption is sealed the first time it is read.
 * - `mcp_run_servers`: the servers each chat's scheduled runs use. Only those are kept alive and warned about: a person
 *   in a chat signs in when the agent gives them the link, a run cannot.
 * - `mcp_waiting`: chats with runs waiting for a sign-in, told when it comes (`onSignedIn`).
 * - `mcp_notices`: what the sidebar shows until the user signs in, or dismisses it.
 * - `mcp_known`: the servers the user has signed in to and not Disconnected, whatever became of the record since (a
 *   refused refresh clears its tokens, a refused client all of it): runs that may use one wait for its sign-in. Stamped
 *   when tokens or a grant are written; records from before the table all count.
 *
 * Changes to a record run one at a time: sealing one awaits, and a sign-in and the refreshes of several chats must not
 * overwrite each other. Opened records are kept in memory (this object is their only writer), so the token read every
 * MCP request makes neither waits nor decrypts.
 */
export class McpSignIns {
  readonly #host: SignInsHost;
  readonly #now: () => number;
  readonly #serially = serial((fn: () => Promise<unknown>) => fn());
  readonly #opened = new Map<string, McpAuthRecord>();
  /** The check of each server under way: a run's check and the keep-alive share one refresh (a rotated refresh token used twice can sign the user out). */
  readonly #checks = new Map<string, Promise<SignInCheck>>();
  #alarmAt: number | null | undefined;

  constructor(host: SignInsHost) {
    this.#host = host;
    this.#now = host.now ?? Date.now;
    const { sql } = host;
    sql.exec(`CREATE TABLE IF NOT EXISTS mcp_auth (server TEXT PRIMARY KEY, data TEXT NOT NULL)`);
    const added = addColumns(sql, "mcp_auth", { signed_in_at: "INTEGER", warned_at: "INTEGER NOT NULL DEFAULT 0", keep_at: "INTEGER NOT NULL DEFAULT 0" });
    if (added.includes("signed_in_at")) {
      // Rows from before are plain JSON: when they were signed in is unknown, so the grant counts from now.
      sql.exec("UPDATE mcp_auth SET signed_in_at = ? WHERE data LIKE '{%' AND json_extract(data, '$.tokens.access_token') IS NOT NULL", this.#now());
    }
    sql.exec(`
      CREATE TABLE IF NOT EXISTS mcp_run_servers (chat_id TEXT NOT NULL, server TEXT NOT NULL, PRIMARY KEY (chat_id, server));
      CREATE TABLE IF NOT EXISTS mcp_waiting (server TEXT NOT NULL, chat_id TEXT NOT NULL, PRIMARY KEY (server, chat_id));
      CREATE TABLE IF NOT EXISTS mcp_notices (server TEXT PRIMARY KEY, kind TEXT NOT NULL, what TEXT);
    `);
    if (!sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mcp_known'").toArray().length) {
      // Records from before the table count as known, lapsed or not (one never finished too: Disconnect forgets it).
      sql.exec("CREATE TABLE mcp_known (server TEXT PRIMARY KEY); INSERT INTO mcp_known (server) SELECT server FROM mcp_auth");
    }
    addColumns(sql, "mcp_notices", { step_reads: "INTEGER NOT NULL DEFAULT 0" });
    // Forget sign-ins to servers this deployment no longer has, tokens included.
    const configured = this.#oauthServers().map((server) => server.name);
    const notIn = configured.length ? ` WHERE server NOT IN (${configured.map(() => "?").join(", ")})` : "";
    for (const table of ["mcp_auth", "mcp_run_servers", "mcp_waiting", "mcp_notices", "mcp_known"]) {
      sql.exec(`DELETE FROM ${table}${notIn}`, ...configured);
    }
  }

  /** The store a connection of this user's uses for one server (McpOAuthClient). */
  store(server: string): McpAuthStore {
    return { get: () => this.record(server), update: (change) => this.update(server, change) };
  }

  async record(server: string): Promise<McpAuthRecord> {
    return this.#opened.get(server) ?? (this.#serially(() => this.#read(server)) as Promise<McpAuthRecord>);
  }

  update(server: string, change: McpAuthChange): Promise<void> {
    return this.#serially(async () => {
      const before = await this.#read(server);
      const after = applyAuthChange(before, change);
      // A change that changed nothing (a refresh or a clear about tokens replaced since) is not sealed and written again.
      if (after !== before) await this.#write(server, before, after);
    }) as Promise<void>;
  }

  /** The account menu's list: every server that signs in each user, signed in or not. */
  list(): McpSignInView[] {
    const grant = grantMs(this.#host.env);
    const rows = new Map(this.#rows().map((row) => [row.server, row]));
    const runs = new Set(this.#runServers());
    const known = new Set(this.known());
    const notices = new Map(
      this.#host.sql
        .exec("SELECT server, kind, what, step_reads FROM mcp_notices")
        .toArray()
        .map((row) => {
          const notice = { kind: row.kind as SignInNoticeKind, what: row.what as string | null, stepReads: Boolean(row.step_reads) };
          return [row.server as string, notice] as const;
        }),
    );
    return this.#oauthServers().map(({ name }) => {
      const signedInAt = rows.get(name)?.signed_in_at ?? undefined;
      const notice = notices.get(name);
      return {
        server: name,
        signedIn: signedInAt !== undefined,
        ...(signedInAt !== undefined && { signedInAt, endsAt: signedInAt + grant }),
        ...(signedInAt === undefined && known.has(name) && { lapsed: true as const }),
        usedByRuns: runs.has(name),
        link: signInPath(name),
        ...(notice && { notice: notice.kind, ...(notice.what && { waiting: notice.what }), ...(notice.stepReads && { stepReads: true as const }) }),
      };
    });
  }

  /**
   * The servers the user signed in to and has not Disconnected: signed in now, or once, whatever a refused refresh left
   * of the record. A run that may use one waits for its sign-in rather than going without. A sign-in never finished (a
   * registration, a sign-in under way) is not one.
   */
  known(): string[] {
    return this.#host.sql
      .exec("SELECT server FROM mcp_known")
      .toArray()
      .map((row) => row.server as string);
  }

  /**
   * Remove a stored sign-in (the account menu's Disconnect), lapsed or not. Nothing waits for it any more: runs waiting
   * for it go on without the server, and later runs too, until the user signs in again.
   */
  async disconnect(server: string): Promise<boolean> {
    const removed = (await this.#serially(async () => {
      const sql = this.#host.sql;
      const auth = sql.exec("DELETE FROM mcp_auth WHERE server = ?", server).rowsWritten > 0;
      const known = sql.exec("DELETE FROM mcp_known WHERE server = ?", server).rowsWritten > 0;
      this.#opened.delete(server);
      sql.exec("DELETE FROM mcp_notices WHERE server = ?", server);
      this.#host.changed();
      this.#schedule();
      return auth || known;
    })) as boolean;
    await this.#release(server);
    return removed;
  }

  /**
   * The servers a chat's scheduled runs use (worker/agents/runs): replaces that chat's list; an empty list clears it.
   * Those are refreshed daily and warned about before their grant ends.
   */
  setRunServers(chatId: string, servers: readonly string[]): void {
    const oauth = new Set(this.#oauthServers().map((server) => server.name));
    const next = [...new Set(servers)].filter((server) => oauth.has(server)).sort();
    const sql = this.#host.sql;
    const now = sql
      .exec("SELECT server FROM mcp_run_servers WHERE chat_id = ? ORDER BY server", chatId)
      .toArray()
      .map((row) => row.server as string);
    if (now.join("\n") === next.join("\n")) return;
    sql.exec("DELETE FROM mcp_run_servers WHERE chat_id = ?", chatId);
    for (const server of next) sql.exec("INSERT INTO mcp_run_servers (chat_id, server) VALUES (?, ?)", chatId, server);
    this.#host.changed();
    this.#schedule();
  }

  /** A chat was deleted: its runs use no server and wait for none. */
  forgetChat(chatId: string): void {
    this.#host.sql.exec("DELETE FROM mcp_waiting WHERE chat_id = ?", chatId);
    if (this.#host.sql.exec("DELETE FROM mcp_run_servers WHERE chat_id = ?", chatId).rowsWritten) {
      this.#host.changed();
      this.#schedule();
    }
  }

  /**
   * Check, before a run starts, that each of `servers` can be used with nobody present: refresh the sign-in of each that
   * signs in each user (servers that do not are `ok`; a name this deployment lacks is `unavailable`). A run with any
   * `needs_sign_in` does not start: it calls `needed`, and goes again once the user signs in. A sign-in refreshed in the
   * last RECENT_REFRESH_MS counts as working without asking again.
   */
  async check(servers: readonly string[]): Promise<Record<string, SignInCheck>> {
    const configs = new Map(mcpServers(this.#host.env).map((server) => [server.name, server]));
    const results = await Promise.all(
      [...new Set(servers)].map(async (name): Promise<[string, SignInCheck]> => {
        const config = configs.get(name);
        if (!config) return [name, "unavailable"];
        if (config.auth !== "oauth") return [name, "ok"];
        // Opening the record first forgets one that no longer opens (a changed key), so the row read after says so.
        const { tokens } = await this.record(name);
        const row = this.#rows().find((r) => r.server === name);
        // keep_at is set a day after each new token: KEEP_ALIVE_MS before it is the last refresh.
        if (tokens && row?.signed_in_at != null && row.keep_at - KEEP_ALIVE_MS > this.#now() - RECENT_REFRESH_MS) return [name, "ok"];
        return [name, await this.#check(config)];
      }),
    );
    return Object.fromEntries(results);
  }

  /**
   * A run, or the daily refresh, found that `server` needs a new sign-in: show a notice with the sign-in link (the
   * sidebar, the browser, a push when no app is open), once until they sign in. With `chatId`, that chat's waiting runs
   * are told when they do. `what` says what is waiting ("Daily brief"). `quiet` (a test run): only the chat is
   * recorded as waiting, with no notice or push.
   */
  async needed(server: string, context: SignInNeededContext = {}): Promise<void> {
    if (!this.#oauthServers().some((s) => s.name === server)) return;
    if (context.chatId) this.#host.sql.exec("INSERT OR IGNORE INTO mcp_waiting (server, chat_id) VALUES (?, ?)", server, context.chatId);
    if (context.quiet) return;
    const what = context.what?.slice(0, 80);
    const set = this.#setNotice(server, "needed", what, context.stepReads);
    if (set === "new") {
      const notice = { type: "sign-in", server, kind: "needed", link: signInPath(server), at: this.#now() } as const;
      await this.#tell({ ...notice, ...(what && { what }), ...(context.stepReads && { stepReads: true }) });
    } else if (set === "changed") this.#host.changed();
  }

  /**
   * The user finished signing in to `server` (the OAuth callback): a new grant starts now, its notice goes, and every
   * chat with runs waiting on it is told.
   */
  async onSignedIn(server: string): Promise<void> {
    const sql = this.#host.sql;
    const now = this.#now();
    // The callback's code exchange saved new tokens just before (the next keep-alive is set from them); a sign-in over
    // tokens that still worked starts a new grant too.
    sql.exec("UPDATE mcp_auth SET signed_in_at = ? WHERE server = ? AND signed_in_at IS NOT NULL", now, server);
    sql.exec("DELETE FROM mcp_notices WHERE server = ?", server);
    this.#host.changed();
    this.#schedule();
    await this.#release(server);
  }

  /** Tell every chat with runs waiting for `server` that they need not wait (signed in, or Disconnected). */
  async #release(server: string): Promise<void> {
    const sql = this.#host.sql;
    const chats = sql
      .exec("SELECT chat_id FROM mcp_waiting WHERE server = ?", server)
      .toArray()
      .map((row) => row.chat_id as string);
    // A chat stays waiting until it heard: one that could not be told is told at the next sign-in.
    await Promise.all(
      chats.map(async (chatId) => {
        try {
          await this.#host.signedIn(chatId, server);
          sql.exec("DELETE FROM mcp_waiting WHERE server = ? AND chat_id = ?", server, chatId);
        } catch (error) {
          console.error("signed in: telling a chat failed:", errorMessage(error));
        }
      }),
    );
  }

  /** Dismiss a notice; it comes back when a run needs the sign-in again. */
  dismiss(server: string): void {
    if (this.#host.sql.exec("DELETE FROM mcp_notices WHERE server = ?", server).rowsWritten) this.#host.changed();
  }

  /** The alarm: warn about grants ending soon (once per grant), refresh the sign-ins runs use, then set the next alarm. */
  async alarm(): Promise<void> {
    const now = this.#now();
    const grant = grantMs(this.#host.env);
    const runs = new Set(this.#runServers());
    const configs = new Map(this.#oauthServers().map((server) => [server.name, server]));
    const rows = this.#signedIn().filter((row) => runs.has(row.server));
    const warnings = rows.flatMap((row) => {
      if (row.warned_at === row.signed_in_at || warnAt(row.signed_in_at, grant) > now) return [];
      this.#host.sql.exec("UPDATE mcp_auth SET warned_at = ? WHERE server = ?", row.signed_in_at, row.server);
      if (!this.#setNotice(row.server, "ending")) return [];
      const endsAt = row.signed_in_at + grant;
      return [this.#tell({ type: "sign-in", server: row.server, kind: "ending", link: signInPath(row.server), endsAt, at: now })];
    });
    const keepAlives = rows.map(async (row) => {
      const config = configs.get(row.server);
      if (!config || row.keep_at > now) return;
      const result = await this.#check(config);
      // A Disconnect while it ran (the row gone) is the user's choice, not a sign-in to ask for.
      if (result === "needs_sign_in" && this.#rows().some((r) => r.server === row.server)) await this.needed(row.server);
      // An ok refresh saved new tokens, which set the next one; `unavailable` tries again soon (`needs_sign_in` ended
      // the grant). It always moves on, or the next alarm is due at once, forever.
      this.#host.sql.exec(
        "UPDATE mcp_auth SET keep_at = ? WHERE server = ?",
        this.#now() + (result === "ok" ? KEEP_ALIVE_MS : KEEP_ALIVE_RETRY_MS),
        row.server,
      );
    });
    await Promise.all([...warnings, ...keepAlives]);
    this.#schedule();
  }

  /** Set the alarm for the next warning or keep-alive due, or clear it. */
  #schedule(): void {
    const grant = grantMs(this.#host.env);
    const runs = new Set(this.#runServers());
    let next = Infinity;
    for (const row of this.#signedIn()) {
      if (!runs.has(row.server)) continue;
      next = Math.min(next, row.keep_at);
      if (row.warned_at !== row.signed_in_at) next = Math.min(next, warnAt(row.signed_in_at, grant));
    }
    const at = Number.isFinite(next) ? Math.max(next, this.#now()) : null;
    if (at === this.#alarmAt) return;
    this.#alarmAt = at;
    this.#host.setAlarm(at);
  }

  /**
   * Put up a notice for `server`, replacing an `ending` one; false when a `needed` one is up already (it says more, and
   * was told once).
   */
  #setNotice(server: string, kind: SignInNoticeKind, what?: string, stepReads = false): "new" | "changed" | false {
    const sql = this.#host.sql;
    // Shown already: once any agent waiting reads it in a step, the notice says so.
    if (sql.exec("SELECT 1 FROM mcp_notices WHERE server = ? AND kind = 'needed'", server).toArray().length) {
      // It names the agent that reads it in a step, as its text says that one cannot go on without it.
      const marked =
        stepReads &&
        sql.exec("UPDATE mcp_notices SET step_reads = 1, what = ? WHERE server = ? AND step_reads = 0", what ?? null, server).rowsWritten > 0;
      return marked ? "changed" : false;
    }
    sql.exec(
      `INSERT INTO mcp_notices (server, kind, what, step_reads) VALUES (?, ?, ?, ?)
       ON CONFLICT(server) DO UPDATE SET kind = excluded.kind, what = excluded.what, step_reads = excluded.step_reads`,
      server,
      kind,
      what ?? null,
      stepReads ? 1 : 0,
    );
    return "new";
  }

  /**
   * Check one server's sign-in, joining a check of it under way. A sign-in that needs the user again ends its grant: tokens
   * a refresh cannot renew (none to refresh with, or refused) are not kept, so it shows as signed out and is not kept alive.
   */
  #check(config: McpServerConfig): Promise<SignInCheck> {
    const { name } = config;
    const running = this.#checks.get(name);
    if (running) return running;
    const checking = (async () => {
      const { tokens } = await this.record(name);
      const result = await (this.#host.check ?? checkSignIn)(config, this.store(name));
      // Only the tokens checked: a sign-in that finished meanwhile stays.
      if (result === "needs_sign_in" && tokens) await this.update(name, { clearTokensIf: tokens });
      return result;
    })().finally(() => this.#checks.delete(name));
    this.#checks.set(name, checking);
    return checking;
  }

  /** The notice reaches every open app, which reads the list again on it: no separate list change. */
  async #tell(notice: SignInNotice): Promise<void> {
    // A lapsed sign-in (known, no tokens) can be Disconnected, so its push says so.
    const lapsed = this.known().includes(notice.server) && !this.#signedIn().some((row) => row.server === notice.server);
    const { title, body } = signInNoticeText({ ...notice, what: undefined, lapsed });
    // A click on the push starts the sign-in.
    await this.#host.notify(notice, { title, body, url: notice.link, tag: `sign-in:${notice.server}` });
  }

  async #read(server: string): Promise<McpAuthRecord> {
    const cached = this.#opened.get(server);
    if (cached) return cached;
    const row = this.#host.sql.exec("SELECT data FROM mcp_auth WHERE server = ?", server).toArray()[0] as { data: string } | undefined;
    if (!row) return {};
    const opened = await openAuthRecord(await this.#host.key(), server, row.data).catch((error: unknown) => {
      // Sealed under another key (MCP_TOKENS_KEY added or changed since): unreadable for good. Forget it, so the user
      // signs in again instead of every call failing.
      console.error(`sign-in record for ${server} does not open, forgetting it:`, errorMessage(error));
      return null;
    });
    if (!opened) {
      await this.#write(server, {}, {});
      // #write saw no tokens before or after: say here that the sign-in went.
      this.#host.changed();
      this.#schedule();
      return {};
    }
    if (opened.plain) {
      await this.#write(server, opened.record, opened.record);
      // Code from before encryption wrote it (a rollback): without tokens it is not signed in; a sign-in it made counts
      // from now (when is not known); a refresh it made keeps the grant.
      if (!opened.record.tokens) this.#host.sql.exec("UPDATE mcp_auth SET signed_in_at = NULL WHERE server = ?", server);
      else if (opened.olderSignIn) this.#host.sql.exec("UPDATE mcp_auth SET signed_in_at = ?, warned_at = 0 WHERE server = ?", this.#now(), server);
      this.#host.changed();
      this.#schedule();
    } else this.#opened.set(server, opened.record);
    return opened.record;
  }

  /** Write `record` sealed. New tokens (a sign-in or a refresh) put the next keep-alive a day off; no tokens end the grant. */
  async #write(server: string, before: McpAuthRecord, record: McpAuthRecord): Promise<void> {
    const sql = this.#host.sql;
    const signedIn = Boolean(record.tokens);
    if (Object.keys(record).length === 0) {
      sql.exec("DELETE FROM mcp_auth WHERE server = ?", server);
      this.#opened.delete(server);
    } else {
      const data = await sealAuthRecord(await this.#host.key(), server, record);
      const now = this.#now();
      const fresh = signedIn && before.tokens?.access_token !== record.tokens?.access_token;
      // A grant starts with the first tokens and ends when they go; a refresh keeps it.
      sql.exec(
        `INSERT INTO mcp_auth (server, data, signed_in_at, keep_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(server) DO UPDATE SET data = excluded.data,
           signed_in_at = CASE WHEN excluded.signed_in_at IS NULL THEN NULL ELSE COALESCE(mcp_auth.signed_in_at, excluded.signed_in_at) END,
           keep_at = CASE WHEN ? THEN excluded.keep_at ELSE mcp_auth.keep_at END`,
        server,
        data,
        signedIn ? now : null,
        now + KEEP_ALIVE_MS,
        fresh ? 1 : 0,
      );
      this.#opened.set(server, record);
      if (record.tokens || record.grant) sql.exec("INSERT OR IGNORE INTO mcp_known (server) VALUES (?)", server);
    }
    if (Boolean(before.tokens) !== signedIn) {
      this.#host.changed();
      this.#schedule();
    }
  }

  #rows(): AuthRow[] {
    return this.#host.sql.exec("SELECT server, signed_in_at, warned_at, keep_at FROM mcp_auth").toArray() as AuthRow[];
  }

  #signedIn(): (AuthRow & { signed_in_at: number })[] {
    return this.#rows().filter((row): row is AuthRow & { signed_in_at: number } => row.signed_in_at !== null);
  }

  #runServers(): string[] {
    return this.#host.sql
      .exec("SELECT DISTINCT server FROM mcp_run_servers")
      .toArray()
      .map((row) => row.server as string);
  }

  #oauthServers(): McpServerConfig[] {
    return oauthServers(this.#host.env);
  }
}
