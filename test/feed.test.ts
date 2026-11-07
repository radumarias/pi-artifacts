import { describe, expect, it } from "vitest";
import { agentFrom, feedPath, findFollow, followKey, MAX_FEED_ITEMS, MAX_FOLLOWERS, MAX_FOLLOWS, type FeedInput, type FollowView } from "../shared/feed.ts";
import { aboutOf, fanOut, FeedStore, followersAllowed, FollowStore, postsReachFollowers, type FanOutHost, type Follower } from "../worker/feed/store.ts";
import { memorySql } from "./fakes.ts";

const T0 = 1_700_000_000_000;

const tag = (n: number, chat = { id: "chat1", kind: "group" }): FeedInput => ({
  kind: "tag",
  ref: `tag:${chat.id}:${n}`,
  at: T0 + n,
  title: `ann mentioned you in Signups (${n})`,
  text: "@bea have you seen these?",
  from: { name: "ann" },
  open: { to: "chat", chatId: chat.id },
  chat,
});

describe("feed: keeping items", () => {
  it("keeps an item once per ref, and a newer state of it as unread again", () => {
    const feed = new FeedStore(memorySql());
    expect(feed.add(tag(1))).toBe("added");
    expect(feed.add(tag(1))).toBe("same");
    expect(feed.list().items).toHaveLength(1);
    feed.mark("all");
    const run: FeedInput = { kind: "run", ref: "run:a1:5", at: T0, title: "@signups is waiting for you to sign in", status: "needs_sign_in", needsYou: true, open: { to: "agent", agentId: "a1" } };
    expect(feed.add(run)).toBe("added");
    feed.mark("all");
    // The run went on once its owner signed in, and sent: the same item, now saying so, to read again.
    expect(feed.add({ ...run, title: "@signups sent its report", status: "sent", needsYou: false })).toBe("updated");
    const items = feed.list().items;
    expect(items).toHaveLength(2);
    expect(items.find((item) => item.kind === "run")).toMatchObject({ title: "@signups sent its report", status: "sent" });
    expect(items.find((item) => item.kind === "run")?.read).toBeUndefined();
    expect(feed.counts()).toEqual({ unread: 1, needsYou: 0 });
  });

  it("refuses an item from an off-the-record chat, as the sender or this person's own row says", () => {
    const feed = new FeedStore(memorySql());
    expect(feed.add(tag(1, { id: "secret", kind: "off_record" }))).toBe("refused");
    // The sender still says group, but this person's sidebar already heard it went off the record.
    expect(feed.add(tag(2, { id: "turned", kind: "group" }), "off_record")).toBe("refused");
    // A kind nobody knows lets nothing out.
    expect(feed.add(tag(3, { id: "odd", kind: "nonsense" }))).toBe("refused");
    // The chat says it is off the record now, while this person's row has not heard yet (it is told off the request's path).
    expect(feed.add(tag(5, { id: "stale", kind: "off_record" }), "group")).toBe("refused");
    expect(feed.add(tag(4, { id: "fine", kind: "page" }), "group")).toBe("added");
    expect(feed.list().items.map((item) => item.title)).toEqual(["ann mentioned you in Signups (4)"]);
  });

  it("keeps read state: by id, all at once, a chat seen, and unread again; what needs the person waits until resolved", () => {
    const feed = new FeedStore(memorySql());
    feed.add(tag(1, { id: "c1", kind: "group" }));
    feed.add(tag(2, { id: "c2", kind: "group" }));
    feed.add({ kind: "assumption", ref: "assumption:a1", at: T0 + 3, title: "Confirm what @signups's draft guessed", open: { to: "agent", agentId: "a1" } });
    feed.add({ kind: "run", ref: "run:a1:1", at: T0 + 4, title: "@signups had nothing to report", status: "not_today", quiet: true, open: { to: "agent", agentId: "a1" } });
    // A quiet run is in the feed but not new; the assumption needs the person.
    expect(feed.counts()).toEqual({ unread: 3, needsYou: 1 });
    expect(feed.list({ needsYou: true }).items.map((item) => item.kind)).toEqual(["assumption"]);

    expect(feed.markChatRead("c1")).toBe(1);
    expect(feed.list({ unread: true }).items.map((item) => item.title)).toEqual(["Confirm what @signups's draft guessed", "ann mentioned you in Signups (2)"]);
    // Read, it still waits on them: only confirming the guesses resolves it.
    const assumption = feed.list({ needsYou: true }).items[0];
    feed.mark([assumption.id]);
    expect(feed.counts()).toEqual({ unread: 1, needsYou: 1 });
    expect(feed.list({ needsYou: true }).items.map((item) => item.kind)).toEqual(["assumption"]);
    expect(feed.resolve("assumption:a1")).toBe(1);
    expect(feed.counts()).toEqual({ unread: 1, needsYou: 0 });
    expect(feed.list({ needsYou: true }).items).toEqual([]);

    const [newest] = feed.list().items;
    expect(feed.mark([newest.id], false)).toBe(1);
    expect(feed.mark([newest.id], false)).toBe(0);
    expect(feed.mark("all")).toBe(2);
    expect(feed.counts().unread).toBe(0);
  });

  it("keeps a question waiting until the person writes to the agent that asked, read or not", () => {
    const feed = new FeedStore(memorySql());
    const brief = { id: "b1", name: "brief", avatar: "br", color: "teal" as const };
    const question = (chatId: string, n: number, agent = brief): FeedInput => ({
      kind: "question",
      ref: `question:${chatId}:${n}`,
      at: T0 + n,
      title: `@${agent.name} asks you something`,
      from: agentFrom(agent),
      open: { to: "chat", chatId },
      chat: { id: chatId, kind: "group" },
    });
    feed.add(question("c1", 1));
    feed.add(question("c2", 2));
    feed.add(question("c1", 3, { ...brief, id: "s1", name: "signups" }));
    // Opening the chat reads them; they still wait for an answer.
    feed.markChatRead("c1");
    expect(feed.counts()).toEqual({ unread: 1, needsYou: 3 });
    // An aside to the people in the chat reaches no agent, and answers nothing.
    expect(feed.resolveReplies("c1", [], T0 + 10)).toBe(0);
    // A message to @signups answers @signups only.
    expect(feed.resolveReplies("c1", ["s1"], T0 + 11)).toBe(1);
    expect(feed.list({ needsYou: true }).items.map((item) => item.title)).toEqual(["@brief asks you something", "@brief asks you something"]);
    expect(feed.resolveReplies("c1", ["b1"], T0 + 12)).toBe(1);
    expect(feed.list({ needsYou: true }).items.map((item) => item.open)).toEqual([{ to: "chat", chatId: "c2" }]);
    // An approval or a guess is not answered by a message.
    const approval: FeedInput = { kind: "approval", ref: "approval:x", at: T0 + 4, title: "@brief wants to post", from: agentFrom(brief), open: { to: "chat", chatId: "c2" } };
    feed.add({ ...approval, chat: { id: "c2", kind: "group" } });
    expect(feed.resolveReplies("c2", ["b1"], T0 + 13)).toBe(1);
    expect(feed.list({ needsYou: true }).items.map((item) => item.kind)).toEqual(["approval"]);
  });

  it("takes a report's question as answered when the owner wrote to its agent after it was posted, before the run ended", () => {
    const feed = new FeedStore(memorySql());
    const report = (n: number): FeedInput => ({
      kind: "run",
      ref: `run:b1:${n}`,
      at: T0 + n,
      title: "@brief asks you something",
      status: "sent",
      needsYou: "reply",
      from: agentFrom({ id: "b1", name: "brief", avatar: "br", color: "teal" }),
      open: { to: "chat", chatId: "home" },
      chat: { id: "home", kind: "private" },
    });
    // Posted at +1, answered at +5, and the run ended (its item added) after.
    feed.resolveReplies("home", ["b1"], T0 + 5);
    feed.add(report(1));
    // Posted at +9, after the last answer: it waits.
    feed.add(report(9));
    expect(feed.list({ needsYou: true }).items.map((item) => item.at)).toEqual([T0 + 9]);
    expect(feed.counts()).toEqual({ unread: 1, needsYou: 1 });
    // A message sent before it was posted (its touch arriving late) does not answer it.
    expect(feed.resolveReplies("home", ["b1"], T0 + 8)).toBe(0);
    // Turned off, its agent's runs wait on nothing.
    feed.add({ ...report(20), needsYou: true }, null, aboutOf("agent", "b1", "ann"));
    expect(feed.resolveAbout(aboutOf("agent", "b1", "ann"), "run")).toBe(1);
    // A draft's guesses still wait for the person to confirm them.
    const confirm = { kind: "assumption", ref: "assumption:b1", at: T0 + 21, title: "Confirm", open: { to: "agent", agentId: "b1" } } as const;
    feed.add(confirm, null, aboutOf("agent", "b1", "ann"));
    expect(feed.resolveAbout(aboutOf("agent", "b1", "ann"), "run")).toBe(0);
  });

  it("lets a chat, or a page or agent, take its items along when it goes", () => {
    const feed = new FeedStore(memorySql());
    feed.add(tag(1, { id: "c1", kind: "group" }));
    feed.add({ kind: "page_version", ref: "version:p1:2", at: T0, title: "Weekly has version 2", open: { to: "page", artifactId: "p1" } }, null, aboutOf("page", "p1", "ann"));
    expect(feed.forgetAbout(aboutOf("page", "p1", "ann"))).toBe(1);
    expect(feed.forgetChat("c1")).toBe(1);
    expect(feed.list().items).toEqual([]);
  });

  it("keeps at most MAX_FEED_ITEMS, the oldest read ones going first", () => {
    const feed = new FeedStore(memorySql());
    for (let n = 0; n < MAX_FEED_ITEMS; n++) feed.add(tag(n));
    feed.mark("all");
    const all = () => feed.list({}, MAX_FEED_ITEMS + 10).items;
    // The oldest is unread again: it outlives the read ones after it.
    feed.mark([all().find((item) => item.title.endsWith("(0)"))!.id], false);
    feed.add(tag(MAX_FEED_ITEMS));
    const titles = all().map((item) => item.title);
    expect(titles).toHaveLength(MAX_FEED_ITEMS);
    expect(titles).toContain("ann mentioned you in Signups (0)");
    expect(titles).not.toContain("ann mentioned you in Signups (1)");
    expect(titles[0]).toBe(`ann mentioned you in Signups (${MAX_FEED_ITEMS})`);
  });

  it("keeps room for new items when what waits on the person fills the feed", () => {
    const feed = new FeedStore(memorySql());
    for (let n = 0; n < MAX_FEED_ITEMS; n++) {
      feed.add({ kind: "assumption", ref: `assumption:a${n}`, at: T0 + n, title: `Confirm a${n}`, open: { to: "agent", agentId: `a${n}` } });
    }
    expect(feed.add(tag(MAX_FEED_ITEMS * 2))).toBe("added");
    const items = feed.list({}, MAX_FEED_ITEMS + 10).items;
    expect(items[0].kind).toBe("tag");
    // Half the feed at most waits; the oldest waiting went first.
    expect(feed.counts().needsYou).toBe(MAX_FEED_ITEMS / 2);
    expect(items.some((item) => item.title === "Confirm a0")).toBe(false);
  });

  it("gives a feed made before waits_on the agent each waiting question asked", () => {
    const sql = memorySql();
    sql.exec(`CREATE TABLE feed (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ref TEXT NOT NULL UNIQUE, at INTEGER NOT NULL,
      read INTEGER NOT NULL DEFAULT 0, needs INTEGER NOT NULL DEFAULT 0, chat_id TEXT, about TEXT, data TEXT NOT NULL)`);
    const from = agentFrom({ id: "b1", name: "brief", avatar: "br", color: "teal" });
    const data = JSON.stringify({ title: "@brief asks you something", from, open: { to: "chat", chatId: "c1" } });
    sql.exec("INSERT INTO feed (kind, ref, at, needs, chat_id, data) VALUES ('question', 'question:c1:1', ?, 2, 'c1', ?)", T0, data);
    const feed = new FeedStore(sql);
    expect(feed.resolveReplies("c1", ["b1"], T0 + 1)).toBe(1);
  });

  it("keeps what still waits on the person when pruning, read or not", () => {
    const feed = new FeedStore(memorySql());
    feed.add({ kind: "approval", ref: "approval:old", at: T0 - 1, title: "@brief wants to post", open: { to: "chat", chatId: "c1" } });
    for (let n = 0; n < MAX_FEED_ITEMS; n++) feed.add(tag(n));
    feed.mark("all");
    feed.add(tag(MAX_FEED_ITEMS));
    expect(feed.list({ needsYou: true }).items.map((item) => item.title)).toEqual(["@brief wants to post"]);
    expect(feed.counts().needsYou).toBe(1);
  });

  it("opens each kind of item where it belongs", () => {
    expect(feedPath({ to: "chat", chatId: "c1" })).toBe("/c/c1");
    expect(feedPath({ to: "page", artifactId: "p1" })).toBe("/a/p1");
    expect(feedPath({ to: "discuss", artifactId: "p1" })).toBe("/a/p1");
    expect(feedPath({ to: "agent", agentId: "a1", tab: "runs" })).toBe("/agents/a1?tab=runs");
    expect(feedPath({ to: "agent", agentId: "a1", chatId: "c1" })).toBe("/agents/a1?chat=c1");
  });
});

describe("follows: both sides", () => {
  it("keeps what a person follows, telling them whose only an agent is (as its chat shows), and who follows a target", () => {
    const sql = memorySql();
    const follows = new FollowStore(sql);
    expect(follows.follow({ kind: "page", id: "p1", ownerUid: "ann", title: "Weekly" }, T0)).toEqual({ ok: true });
    expect(follows.follow({ kind: "agent", id: "a1", ownerUid: "ann", title: "@signups", chatOwner: "ann", chatId: "c1" }, T0 + 1)).toEqual({ ok: true });
    expect(follows.list()).toEqual([
      { kind: "agent", id: "a1", title: "@signups", chatId: "c1", ownerUid: "ann", at: T0 + 1 },
      { kind: "page", id: "p1", title: "Weekly", at: T0 },
    ]);
    expect(follows.get("page", "p1", "ann")).not.toBeNull();
    // An item that says it is from someone else's target of that id is not this follow's.
    expect(follows.get("page", "p1", "cai")).toBeNull();
    expect(follows.retitle("page", "p1", "ann", "Weekly signups")).toBe(true);
    expect(follows.retitle("page", "p1", "ann", "Weekly signups")).toBe(false);
    expect(follows.get("page", "p1", "ann")?.title).toBe("Weekly signups");
    expect(follows.unfollow("page", "p1", "ann")?.ownerUid).toBe("ann");
    expect(follows.unfollow("page", "p1", "ann")).toBeNull();
  });

  it("tells two people's agents of one id apart, followed from chats of one id", () => {
    const follows = new FollowStore(memorySql());
    follows.follow({ kind: "agent", id: "a1", ownerUid: "ann", title: "@brief", chatOwner: "ann", chatId: "c1" }, T0);
    follows.follow({ kind: "agent", id: "a1", ownerUid: "eve", title: "@brief", chatOwner: "dan", chatId: "c1" }, T0 + 1);
    expect(follows.list()).toHaveLength(2);
    expect(follows.through("dan", "c1").map((follow) => follow.ownerUid)).toEqual(["eve"]);
    expect(follows.unfollow("agent", "a1", "ann")).not.toBeNull();
    expect(follows.get("agent", "a1", "eve")).not.toBeNull();
    expect(aboutOf("agent", "a1", "ann")).not.toBe(aboutOf("agent", "a1", "eve"));
  });

  it("finds a follow by kind, id and whose it is: an agent followed from one chat shows from any, never another person's", () => {
    const follows: FollowView[] = [
      { kind: "agent", id: "a1", title: "@brief", chatId: "c1", ownerUid: "ann", at: T0 },
      { kind: "agent", id: "a1", title: "@brief", chatId: "c1", ownerUid: "eve", at: T0 + 1 },
      { kind: "page", id: "p1", title: "Weekly", at: T0 + 2 },
    ];
    expect(findFollow(follows, { kind: "agent", id: "a1", ownerUid: "eve" })?.at).toBe(T0 + 1);
    expect(findFollow(follows, { kind: "agent", id: "a1", ownerUid: "cai" })).toBeUndefined();
    expect(findFollow(follows, { kind: "page", id: "p1" })?.title).toBe("Weekly");
    expect(new Set(follows.map(followKey)).size).toBe(3);
    const store = new FollowStore(memorySql());
    store.follow({ kind: "page", id: "p1", ownerUid: "ann", title: "Weekly" }, T0);
    expect(store.findPage("p1")?.ownerUid).toBe("ann");
    expect(store.findPage("p2")).toBeNull();
  });

  it("refuses past MAX_FOLLOWS and MAX_FOLLOWERS, but following again is not counted twice", () => {
    const follows = new FollowStore(memorySql());
    for (let n = 0; n < MAX_FOLLOWS; n++) expect(follows.follow({ kind: "page", id: `p${n}`, ownerUid: "ann", title: "x" })).toEqual({ ok: true });
    expect(follows.follow({ kind: "page", id: "one-more", ownerUid: "ann", title: "x" })).toHaveProperty("error");
    expect(follows.follow({ kind: "page", id: "p0", ownerUid: "ann", title: "again" })).toEqual({ ok: true });

    for (let n = 0; n < MAX_FOLLOWERS; n++) expect(follows.addFollower("page", "mine", { uid: `u${n}` })).toEqual({ ok: true });
    expect(follows.addFollower("page", "mine", { uid: "late" })).toHaveProperty("error");
    expect(follows.addFollower("page", "mine", { uid: "u0" })).toEqual({ ok: true });
  });

  it("forgets a target's followers when it goes, and returns them to be told", () => {
    const follows = new FollowStore(memorySql());
    follows.addFollower("agent", "a1", { uid: "bea", via: { ownerUid: "ann", chatId: "c1" } });
    follows.addFollower("agent", "a1", { uid: "cai", via: { ownerUid: "dan", chatId: "c2" } });
    follows.removeFollower("agent", "a1", "cai");
    expect(follows.followersOf("agent", "a1")).toEqual([{ uid: "bea", via: { ownerUid: "ann", chatId: "c1" } }]);
    expect(follows.dropTarget("agent", "a1")).toEqual(["bea"]);
    expect(follows.followersOf("agent", "a1")).toEqual([]);
  });
});

/** A fan-out's host: who each chat still lets in, who still follows, and what was handed out. */
function host(rights: Record<string, string[]>, following: Set<string>, failing = new Set<string>()) {
  const delivered: string[] = [];
  const forgotten: string[] = [];
  const lost: string[] = [];
  const asked: string[] = [];
  const fake: FanOutHost = {
    stillIn: async (via, uids) => {
      asked.push(`${via.ownerUid}/${via.chatId}:${uids.join(",")}`);
      if (failing.has(`${via.ownerUid}/${via.chatId}`)) throw new Error("chat unreachable");
      // A chat answering for someone it was not asked about is not trusted for them.
      return [...(rights[`${via.ownerUid}/${via.chatId}`] ?? []), "mallory"];
    },
    deliver: async (uid) => {
      if (failing.has(uid)) throw new Error("directory unreachable");
      if (!following.has(uid)) return false;
      delivered.push(uid);
      return true;
    },
    forget: (uid) => forgotten.push(uid),
    lost: (uid) => lost.push(uid),
  };
  return { fake, delivered, forgotten, lost, asked };
}

describe("fan-out to followers", () => {
  it("hands a page's item to each of its followers, forgets those who stopped, and keeps those it could not reach", async () => {
    const followers: Follower[] = [{ uid: "bea" }, { uid: "cai" }, { uid: "dan" }];
    const { fake, delivered, forgotten } = host({}, new Set(["bea", "dan"]), new Set(["dan"]));
    expect(await fanOut("page", followers, fake)).toEqual(["bea"]);
    expect(delivered).toEqual(["bea"]);
    expect(forgotten).toEqual(["cai"]);
  });

  it("hands an agent's post only to followers the chat they followed it from still lets open it, asking each chat once", async () => {
    const followers: Follower[] = [
      { uid: "bea", via: { ownerUid: "ann", chatId: "c1" } },
      { uid: "cai", via: { ownerUid: "ann", chatId: "c1" } },
      { uid: "dan", via: { ownerUid: "eve", chatId: "c2" } },
      // From before chats were kept with a follow: nothing says they may still open it.
      { uid: "fay" },
    ];
    const { fake, delivered, asked, lost } = host({ "ann/c1": ["bea"], "eve/c2": ["dan"] }, new Set(["bea", "cai", "dan", "fay", "mallory"]));
    expect((await fanOut("agent", followers, fake)).sort()).toEqual(["bea", "dan"]);
    expect(delivered.sort()).toEqual(["bea", "dan"]);
    expect(asked).toEqual(["ann/c1:bea,cai", "eve/c2:dan"]);
    // Out of the chat, or with no chat at all: they may no longer open it, so they stop following.
    expect(lost.sort()).toEqual(["cai", "fay"]);
  });

  it("forgets nobody when a chat cannot be asked", async () => {
    const followers: Follower[] = [{ uid: "bea", via: { ownerUid: "ann", chatId: "c1" } }];
    const { fake, delivered, lost } = host({ "ann/c1": ["bea"] }, new Set(["bea"]), new Set(["ann/c1"]));
    expect(await fanOut("agent", followers, fake)).toEqual([]);
    expect(delivered).toEqual([]);
    expect(lost).toEqual([]);
  });

  it("lets a chat let in only people in it, while the agent's owner shares it there", () => {
    const entry = { ownerUid: "ann", shared: true };
    const inChat = (uid: string) => ["ann", "bea"].includes(uid);
    expect(followersAllowed(entry, "ann", ["ann", "bea", "cai"], inChat)).toEqual(["bea"]);
    expect(followersAllowed({ ...entry, shared: false }, "ann", ["bea"], inChat)).toEqual([]);
    // The roster's agent of that id is someone else's.
    expect(followersAllowed(entry, "eve", ["bea"], inChat)).toEqual([]);
    expect(followersAllowed(null, "ann", ["bea"], inChat)).toEqual([]);
  });

  it("lets an agent's posts reach followers only when everything it may read is shared with chats", () => {
    const all = ["sales", "crm", "weather"];
    const signsIn = (server: string) => server === "crm";
    // Every server, and one of them signs in as its owner.
    expect(postsReachFollowers({}, all, signsIn)).toBe(false);
    expect(postsReachFollowers({ servers: ["sales", "weather"] }, all, signsIn)).toBe(true);
    expect(postsReachFollowers({ servers: ["sales", "crm"], sharedServers: ["sales", "crm"] }, all, signsIn)).toBe(true);
    expect(postsReachFollowers({ servers: ["sales", "weather"], sharedServers: ["sales"] }, all, signsIn)).toBe(false);
  });
});
