import { describe, expect, it } from "vitest";
import type { SignInNotice } from "../shared/sign-ins.ts";
import { assertReadOnly, grantMs, KEEP_ALIVE_MS, readOnlyTools, WARN_AHEAD_MS, warnAt, type SignInCheck } from "../worker/mcp/background.ts";
import { McpFailure } from "../worker/mcp/hub.ts";
import { McpOAuthClient } from "../worker/mcp/oauth.ts";
import { openAuthRecord, sealAuthRecord } from "../worker/mcp/sealed.ts";
import { McpSignIns, RECENT_REFRESH_MS } from "../worker/mcp/sign-ins.ts";
import { deriveUserAesKey } from "../worker/storage/keys.ts";
import { MASTER_KEY, memorySql } from "./fakes.ts";

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_800_000_000_000;
const SERVERS = [
  { name: "Portal", url: "https://portal.example/mcp", auth: "oauth" },
  { name: "Public", url: "https://public.example/mcp" },
];
const TOKENS = { access_token: "at-1", token_type: "Bearer", refresh_token: "rt-1" };
const CLIENT = { client_id: "c1", redirect_uris: ["https://app.example/api/mcp/oauth/callback"] };

const key = () => deriveUserAesKey(MASTER_KEY, "MCP_TOKENS_KEY", "pi-artifacts/mcp-tokens/v1", "ada");

/** A user's sign-ins over an in-memory database, with a clock, a scripted check, and everything they tell recorded. */
function setup(options: { sql?: ReturnType<typeof memorySql>; check?: SignInCheck; grantDays?: string } = {}) {
  const sql = options.sql ?? memorySql();
  let now = T0;
  const told: SignInNotice[] = [];
  const pushed: string[] = [];
  const chats: string[] = [];
  const alarms: (number | null)[] = [];
  const checks: string[] = [];
  const failing = new Set<string>();
  let gate: Promise<void> | undefined;
  let result: SignInCheck = options.check ?? "ok";
  const signIns = new McpSignIns({
    sql,
    env: { MCP_SERVERS: SERVERS, MCP_GRANT_DAYS: options.grantDays ?? "30" },
    key,
    changed: () => {},
    notify: async (notice, push) => {
      told.push(notice);
      pushed.push(`${push.title} | ${push.body}`);
    },
    signedIn: async (chatId, server) => {
      if (failing.has(chatId)) throw new Error("chat down");
      chats.push(`${chatId}:${server}`);
    },
    setAlarm: (at) => void alarms.push(at),
    check: async (server, store) => {
      checks.push(server.name);
      await gate;
      // An ok check refreshes, as the real one does: new tokens.
      if (result === "ok") await store.update({ set: { tokens: { ...TOKENS, access_token: `at-${checks.length + 1}` } } });
      return result;
    },
    now: () => now,
  });
  return {
    sql,
    signIns,
    told,
    pushed,
    chats,
    alarms,
    checks,
    at: (to: number) => void (now = to),
    answer: (next: SignInCheck) => void (result = next),
    failing,
    /** Hold checks until the returned function is called. */
    hold: () => {
      let release!: () => void;
      gate = new Promise((resolve) => (release = resolve));
      return release;
    },
    row: (server = "Portal") => sql.exec("SELECT * FROM mcp_auth WHERE server = ?", server).toArray()[0] as Record<string, unknown> | undefined,
  };
}

/** Sign in the way the callback does: tokens saved by the OAuth client, then the hook. */
async function signIn(s: ReturnType<typeof setup>, at: number) {
  s.at(at);
  await s.signIns.update("Portal", { set: { client: CLIENT, tokens: TOKENS } });
  await s.signIns.onSignedIn("Portal");
}

describe("sealed sign-in records", () => {
  it("round trips, and opens only for the server it was sealed for", async () => {
    const record = { client: CLIENT, tokens: TOKENS };
    const sealed = await sealAuthRecord(await key(), "Portal", record);
    expect(JSON.parse(sealed)).toEqual({ sealed: expect.stringMatching(/^v1\./) });
    expect(sealed).not.toContain("rt-1");
    expect(await openAuthRecord(await key(), "Portal", sealed)).toEqual({ record, plain: false, olderSignIn: false });
    await expect(openAuthRecord(await key(), "Other", sealed)).rejects.toThrow();
    const otherUser = await deriveUserAesKey(MASTER_KEY, "MCP_TOKENS_KEY", "pi-artifacts/mcp-tokens/v1", "bob");
    await expect(openAuthRecord(otherUser, "Portal", sealed)).rejects.toThrow();
  });

  it("a key from FILES_MASTER_KEY under its own label differs from the token key", async () => {
    const a = await sealAuthRecord(await key(), "Portal", {});
    const fromFiles = await deriveUserAesKey(MASTER_KEY, "FILES_MASTER_KEY", "pi-artifacts/mcp-tokens-from-files/v1", "ada");
    await expect(openAuthRecord(fromFiles, "Portal", a)).rejects.toThrow();
  });

  it("seals a plaintext row from before on first read, and counts its grant from then", async () => {
    const sql = memorySql();
    sql.exec("CREATE TABLE mcp_auth (server TEXT PRIMARY KEY, data TEXT NOT NULL)");
    sql.exec("INSERT INTO mcp_auth (server, data) VALUES (?, ?)", "Portal", JSON.stringify({ client: CLIENT, tokens: TOKENS }));
    const s = setup({ sql });
    expect(s.row()).toMatchObject({ signed_in_at: T0 });
    expect(await s.signIns.record("Portal")).toEqual({ client: CLIENT, tokens: TOKENS });
    expect(String(s.row()!.data)).toMatch(/^\{"sealed":"v1\./);
    expect(await s.signIns.record("Portal")).toEqual({ client: CLIENT, tokens: TOKENS });
  });

  it("forgets a record sealed under another key, so the user signs in again", async () => {
    const sql = memorySql();
    const s = setup({ sql });
    const otherKey = await deriveUserAesKey(MASTER_KEY, "FILES_MASTER_KEY", "pi-artifacts/mcp-tokens-from-files/v1", "ada");
    const sealed = await sealAuthRecord(otherKey, "Portal", { client: CLIENT, tokens: TOKENS });
    sql.exec("INSERT INTO mcp_auth (server, data, signed_in_at) VALUES (?, ?, ?)", "Portal", sealed, T0);
    expect(await s.signIns.record("Portal")).toEqual({});
    expect(s.row()).toBeUndefined();
  });

  it("stays JSON with no sign-in for code from before, and takes what that code wrote over it", async () => {
    const sealed = await sealAuthRecord(await key(), "Portal", { client: CLIENT, tokens: TOKENS });
    // What code from before encryption makes of it: a record with no client and no tokens.
    expect(JSON.parse(sealed)).not.toHaveProperty("tokens");
    const newer = { ...JSON.parse(sealed), client: CLIENT, tokens: { ...TOKENS, access_token: "at-old-code" } };
    expect(await openAuthRecord(await key(), "Portal", JSON.stringify(newer))).toEqual({
      record: { client: CLIENT, tokens: { ...TOKENS, access_token: "at-old-code" } },
      plain: true,
      olderSignIn: false,
    });
  });

  it("opens a record sealed as a bare v1 string, and writes it again as JSON", async () => {
    const sql = memorySql();
    const s = setup({ sql });
    const bare = JSON.parse(await sealAuthRecord(await key(), "Portal", { client: CLIENT, tokens: TOKENS })).sealed as string;
    sql.exec("INSERT INTO mcp_auth (server, data, signed_in_at) VALUES (?, ?, ?)", "Portal", bare, T0);
    expect(await s.signIns.record("Portal")).toEqual({ client: CLIENT, tokens: TOKENS });
    expect(String(s.row()!.data)).toMatch(/^\{"sealed":"v1\./);
    expect(s.row()).toMatchObject({ signed_in_at: T0 });
  });

  it("does not trust a recent refresh of a record that no longer opens", async () => {
    const sql = memorySql();
    const s = setup({ sql, check: "needs_sign_in" });
    const otherKey = await deriveUserAesKey(MASTER_KEY, "FILES_MASTER_KEY", "pi-artifacts/mcp-tokens-from-files/v1", "ada");
    const sealed = await sealAuthRecord(otherKey, "Portal", { client: CLIENT, tokens: TOKENS });
    sql.exec("INSERT INTO mcp_auth (server, data, signed_in_at, keep_at) VALUES (?, ?, ?, ?)", "Portal", sealed, T0, T0 + KEEP_ALIVE_MS);
    expect(await s.signIns.check(["Portal"])).toEqual({ Portal: "needs_sign_in" });
  });

  it("forgets sign-ins to servers no longer configured", () => {
    const sql = memorySql();
    sql.exec("CREATE TABLE mcp_auth (server TEXT PRIMARY KEY, data TEXT NOT NULL)");
    sql.exec("INSERT INTO mcp_auth (server, data) VALUES (?, ?)", "Gone", "{}");
    expect(setup({ sql }).row("Gone")).toBeUndefined();
  });
});

describe("sign-ins with nobody present", () => {
  it("lists each server that signs in each user, with its grant", async () => {
    const s = setup();
    expect(s.signIns.list()).toEqual([{ server: "Portal", signedIn: false, usedByRuns: false, link: "/api/mcp/sign-in/Portal" }]);
    await signIn(s, T0);
    s.signIns.setRunServers("chat1", ["Portal", "Public", "Unknown"]);
    expect(s.signIns.list()).toEqual([
      { server: "Portal", signedIn: true, signedInAt: T0, endsAt: T0 + 30 * DAY, usedByRuns: true, link: "/api/mcp/sign-in/Portal" },
    ]);
  });

  it("checks only servers that sign in each user", async () => {
    const s = setup({ check: "needs_sign_in" });
    expect(await s.signIns.check(["Public", "Portal", "Nowhere"])).toEqual({ Public: "ok", Portal: "needs_sign_in", Nowhere: "unavailable" });
    expect(s.checks).toEqual(["Portal"]);
  });

  it("tells once that a sign-in is needed, and the waiting chats when the user signs in", async () => {
    const s = setup();
    await s.signIns.needed("Portal", { chatId: "chat1", what: "Daily brief" });
    await s.signIns.needed("Portal", { chatId: "chat2", what: "Weekly report" });
    expect(s.told).toHaveLength(1);
    expect(s.told[0]).toMatchObject({ type: "sign-in", server: "Portal", kind: "needed", link: "/api/mcp/sign-in/Portal", what: "Daily brief" });
    // The push says only that something is waiting: not what.
    expect(s.pushed[0]).not.toContain("Daily brief");
    expect(s.signIns.list()[0]!.notice).toBe("needed");
    await signIn(s, T0 + DAY);
    expect(s.chats.sort()).toEqual(["chat1:Portal", "chat2:Portal"]);
    expect(s.signIns.list()[0]!.notice).toBeUndefined();
    // Told once: a later sign-in tells nobody.
    await signIn(s, T0 + 2 * DAY);
    expect(s.chats).toHaveLength(2);
  });

  it("keeps a lapsed sign-in among the known ones until Disconnect", async () => {
    const s = setup();
    expect(await s.signIns.known()).toEqual([]);
    // A sign-in started and never finished (its registration, its state) is no sign-in to wait for.
    await s.signIns.update("Portal", { set: { client: CLIENT, state: "Portal~x", redirectUrl: "https://pi.test/cb" } });
    expect(await s.signIns.known()).toEqual([]);
    // The callback's code exchange saves the tokens with their grant.
    s.at(T0);
    await s.signIns.update("Portal", { set: { tokens: TOKENS, grant: "g1" } });
    await s.signIns.onSignedIn("Portal");
    s.answer("needs_sign_in");
    s.at(T0 + DAY);
    expect(await s.signIns.check(["Portal"])).toEqual({ Portal: "needs_sign_in" });
    // The refused refresh ended the grant (signed out), but the record says the user signs in to it.
    expect(s.signIns.list()[0]!.signedIn).toBe(false);
    expect(await s.signIns.known()).toEqual(["Portal"]);
    await s.signIns.disconnect("Portal");
    expect(await s.signIns.known()).toEqual([]);
  });

  it("records a test run's chat as waiting without telling the user", async () => {
    const s = setup();
    await s.signIns.needed("Portal", { chatId: "chat1", what: "@brief", quiet: true });
    expect(s.told).toHaveLength(0);
    expect(s.pushed).toHaveLength(0);
    expect(s.signIns.list()[0]?.notice).toBeUndefined();
    await signIn(s, T0 + DAY);
    expect(s.chats).toEqual(["chat1:Portal"]);
  });

  it("warns once per grant, a few days before it ends, only for servers runs use", async () => {
    const s = setup();
    await signIn(s, T0);
    const grant = 30 * DAY;
    expect(warnAt(T0, grant)).toBe(T0 + grant - WARN_AHEAD_MS);
    s.at(warnAt(T0, grant));
    await s.signIns.alarm();
    expect(s.told).toHaveLength(0);

    s.signIns.setRunServers("chat1", ["Portal"]);
    s.at(warnAt(T0, grant) - 1);
    await s.signIns.alarm();
    expect(s.told).toHaveLength(0);
    s.at(warnAt(T0, grant));
    await s.signIns.alarm();
    expect(s.told).toEqual([expect.objectContaining({ kind: "ending", server: "Portal", endsAt: T0 + grant })]);
    await s.signIns.alarm();
    expect(s.told).toHaveLength(1);

    // A new sign-in starts a new grant, and with it a new warning.
    await signIn(s, T0 + 28 * DAY);
    s.at(warnAt(T0 + 28 * DAY, grant));
    await s.signIns.alarm();
    expect(s.told).toHaveLength(2);
  });

  it("warns a tenth of a short grant before it ends, not right after the sign-in", () => {
    expect(warnAt(T0, DAY)).toBe(T0 + DAY - DAY / 10);
    expect(warnAt(T0, 3 * DAY)).toBe(T0 + 3 * DAY - (3 * DAY) / 10);
  });

  it("follows MCP_GRANT_DAYS", () => {
    expect(grantMs({ MCP_GRANT_DAYS: "7" })).toBe(7 * DAY);
    expect(grantMs({ MCP_GRANT_DAYS: "nonsense" })).toBe(30 * DAY);
    expect(grantMs({})).toBe(30 * DAY);
  });

  it("keeps a sign-in runs use alive daily, and asks for a new one when the refresh is refused", async () => {
    const s = setup();
    await signIn(s, T0);
    s.signIns.setRunServers("chat1", ["Portal"]);
    expect(s.alarms.at(-1)).toBe(T0 + KEEP_ALIVE_MS);
    s.at(T0 + KEEP_ALIVE_MS - 1);
    await s.signIns.alarm();
    expect(s.checks).toEqual([]);
    s.at(T0 + KEEP_ALIVE_MS);
    await s.signIns.alarm();
    expect(s.checks).toEqual(["Portal"]);
    // The refresh saved new tokens: the next keep-alive is a day from now.
    expect(s.row()!.keep_at).toBe(T0 + 2 * KEEP_ALIVE_MS);

    s.answer("unavailable");
    s.at(T0 + 2 * KEEP_ALIVE_MS);
    await s.signIns.alarm();
    expect(s.told).toHaveLength(0);
    expect(Number(s.row()!.keep_at)).toBeLessThan(T0 + 3 * KEEP_ALIVE_MS);

    s.answer("needs_sign_in");
    s.at(T0 + 3 * KEEP_ALIVE_MS);
    await s.signIns.alarm();
    expect(s.told).toEqual([expect.objectContaining({ kind: "needed", server: "Portal" })]);
  });

  it("ends the grant when a sign-in needs the user again, so it is neither shown signed in nor kept alive", async () => {
    const s = setup();
    await signIn(s, T0);
    s.signIns.setRunServers("chat1", ["Portal"]);
    s.answer("needs_sign_in");
    s.at(T0 + RECENT_REFRESH_MS + 1);
    expect(await s.signIns.check(["Portal"])).toEqual({ Portal: "needs_sign_in" });
    expect(s.signIns.list()[0]).toMatchObject({ signedIn: false });
    expect((await s.signIns.record("Portal")).tokens).toBeUndefined();
    expect(s.alarms.at(-1)).toBeNull();
  });

  it("runs one refresh at a time per server: a run's check and the keep-alive share it", async () => {
    const s = setup();
    await signIn(s, T0);
    s.signIns.setRunServers("chat1", ["Portal"]);
    s.at(T0 + KEEP_ALIVE_MS);
    const release = s.hold();
    const both = Promise.all([s.signIns.check(["Portal"]), s.signIns.check(["Portal"]), s.signIns.alarm()]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    const [a, b] = await both;
    expect(a).toEqual({ Portal: "ok" });
    expect(b).toEqual({ Portal: "ok" });
    expect(s.checks).toEqual(["Portal"]);
  });

  it("a refresh saves only into the grant it refreshed: not after Disconnect, nor over a new sign-in", async () => {
    const s = setup();
    const redirectUrl = CLIENT.redirect_uris[0]!;
    const client = (interactive = false) => new McpOAuthClient(s.signIns.store("Portal"), "Portal", { redirectUrl, interactive });
    /** A sign-in's code exchange: a new grant. */
    const signInFresh = async (accessToken: string) => {
      await s.signIns.update("Portal", { set: { client: CLIENT } });
      await client(true).saveTokens({ ...TOKENS, access_token: accessToken });
    };

    await signInFresh("at-1");
    const chat = client();
    await chat.tokens();
    await s.signIns.disconnect("Portal");
    // A parallel request on the same connection reads nothing; the refresh in flight then lands.
    expect(await chat.tokens()).toBeUndefined();
    await chat.saveTokens({ ...TOKENS, access_token: "at-late" });
    expect(s.row()).toBeUndefined();
    expect(s.signIns.list()[0]).toMatchObject({ signedIn: false });

    await signInFresh("at-2");
    const old = client();
    await old.tokens();
    await signInFresh("at-3");
    // The old grant's refresh lands after the new sign-in, and its connection's next read fails, to be opened afresh.
    await old.saveTokens({ ...TOKENS, access_token: "at-late" });
    expect((await s.signIns.record("Portal")).tokens?.access_token).toBe("at-3");
    await expect(old.tokens()).rejects.toThrow(/again/);

    // A connection opened now refreshes into the new grant.
    const fresh = client();
    await fresh.tokens();
    await fresh.saveTokens({ ...TOKENS, access_token: "at-4" });
    expect((await s.signIns.record("Portal")).tokens?.access_token).toBe("at-4");
    // A client that never read tokens has nothing to save into.
    await client().saveTokens({ ...TOKENS, access_token: "at-stray" });
    expect((await s.signIns.record("Portal")).tokens?.access_token).toBe("at-4");
  });

  it("counts the grant from when it reopens a plain record that code from before wrote", async () => {
    const sql = memorySql();
    const s = setup({ sql });
    await signIn(s, T0);
    // A rollback: old code wrote the record plain, as a new sign-in.
    sql.exec("UPDATE mcp_auth SET data = ? WHERE server = 'Portal'", JSON.stringify({ client: CLIENT, tokens: TOKENS }));
    s.at(T0 + 10 * DAY);
    const reopened = setup({ sql });
    reopened.at(T0 + 10 * DAY);
    await reopened.signIns.record("Portal");
    expect(reopened.row()).toMatchObject({ signed_in_at: T0 + 10 * DAY });
    // A refresh old code made keeps `sealed` beside its fields: the grant keeps its start.
    const sealedNow = String(reopened.row()!.data);
    sql.exec("UPDATE mcp_auth SET data = ? WHERE server = 'Portal'", JSON.stringify({ ...JSON.parse(sealedNow), client: CLIENT, tokens: TOKENS }));
    const refreshed = setup({ sql });
    refreshed.at(T0 + 20 * DAY);
    await refreshed.signIns.record("Portal");
    expect(refreshed.row()).toMatchObject({ signed_in_at: T0 + 10 * DAY });
    sql.exec("UPDATE mcp_auth SET data = ? WHERE server = 'Portal'", JSON.stringify({ client: CLIENT, state: "s" }));
    const signedOut = setup({ sql });
    await signedOut.signIns.record("Portal");
    expect(signedOut.signIns.list()[0]).toMatchObject({ signedIn: false });
  });

  it("keeps a chat waiting until it could be told", async () => {
    const s = setup();
    await s.signIns.needed("Portal", { chatId: "chat1" });
    await s.signIns.needed("Portal", { chatId: "chat2" });
    s.failing.add("chat2");
    await signIn(s, T0);
    expect(s.chats).toEqual(["chat1:Portal"]);
    s.failing.clear();
    await signIn(s, T0 + DAY);
    expect(s.chats).toEqual(["chat1:Portal", "chat2:Portal"]);
  });

  it("trusts a refresh from the last hour before a run, and refreshes an older one", async () => {
    const s = setup();
    await signIn(s, T0);
    s.at(T0 + RECENT_REFRESH_MS - 1);
    expect(await s.signIns.check(["Portal"])).toEqual({ Portal: "ok" });
    expect(s.checks).toEqual([]);
    s.at(T0 + RECENT_REFRESH_MS + 1);
    expect(await s.signIns.check(["Portal"])).toEqual({ Portal: "ok" });
    expect(s.checks).toEqual(["Portal"]);
  });

  it("forgets a deleted chat's runs: its servers are no longer kept alive, and it is not told", async () => {
    const s = setup();
    await signIn(s, T0);
    s.signIns.setRunServers("chat1", ["Portal"]);
    await s.signIns.needed("Portal", { chatId: "chat1" });
    s.signIns.forgetChat("chat1");
    expect(s.signIns.list()[0]!.usedByRuns).toBe(false);
    expect(s.alarms.at(-1)).toBeNull();
    await signIn(s, T0 + DAY);
    expect(s.chats).toEqual([]);
  });

  it("sets the alarm only when it changes", async () => {
    const s = setup();
    await signIn(s, T0);
    s.signIns.setRunServers("chat1", ["Portal"]);
    const set = s.alarms.length;
    s.signIns.setRunServers("chat1", ["Portal", "Portal"]);
    s.signIns.setRunServers("chat2", ["Portal"]);
    expect(s.alarms).toHaveLength(set);
  });

  it("clears the alarm when no run uses a signed-in server", async () => {
    const s = setup();
    await signIn(s, T0);
    s.signIns.setRunServers("chat1", ["Portal"]);
    s.signIns.setRunServers("chat1", []);
    expect(s.alarms.at(-1)).toBeNull();
  });

  it("ends the grant when the tokens go, and Disconnect forgets the record", async () => {
    const s = setup();
    await signIn(s, T0);
    await s.signIns.update("Portal", { clear: ["tokens"] });
    expect(s.signIns.list()[0]).toMatchObject({ signedIn: false });
    expect(s.row()).toMatchObject({ signed_in_at: null });
    await signIn(s, T0 + DAY);
    expect(await s.signIns.disconnect("Portal")).toBe(true);
    expect(s.row()).toBeUndefined();
    expect(await s.signIns.record("Portal")).toEqual({});
  });

  it("changes one record at a time", async () => {
    const s = setup();
    await Promise.all(Array.from({ length: 10 }, (_, i) => s.signIns.update("Portal", { set: { [`state`]: `s${i}` } })));
    expect((await s.signIns.record("Portal")).state).toBe("s9");
  });
});

describe("read-only tools for runs", () => {
  const hub = {
    tools: async () => [
      { name: "list_items", description: "", annotations: { readOnlyHint: true } },
      { name: "send_mail", description: "" },
    ],
  };
  it("offers only tools marked read-only, and refuses any other call", async () => {
    expect((await readOnlyTools(hub, "Portal")).map((tool) => tool.name)).toEqual(["list_items"]);
    await expect(assertReadOnly(hub, "Portal", "list_items")).resolves.toBeUndefined();
    const refused = await assertReadOnly(hub, "Portal", "send_mail").catch((error) => error);
    expect(refused).toBeInstanceOf(McpFailure);
    expect((refused as McpFailure).error.code).toBe("not_granted");
  });
});
