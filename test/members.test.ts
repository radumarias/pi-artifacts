import { describe, expect, it } from "vitest";
import { secondSeat, secondSeatUid, UID_PATTERN } from "../shared/protocol.ts";
import { ChatMembers, formatInviteToken, INVITE_TTL_MS, MAX_OPEN_INVITES, parseInviteToken } from "../worker/members.ts";
import { memorySql } from "./fakes.ts";

const ann = { uid: "ann", name: "ann@example.com" };
const bob = { uid: "bob", name: "bob@example.com" };
const T0 = 1_000_000;

async function invited(members: ChatMembers, now = T0) {
  const created = await members.createInvite(now);
  if ("error" in created) throw new Error(created.error);
  return created;
}

describe("ChatMembers", () => {
  it("lets one person join by an invite, once", async () => {
    const members = new ChatMembers(memorySql());
    const { invite, secret } = await invited(members);
    expect(members.invites(T0)).toEqual([invite]);

    expect(await members.accept(secret, ann, T0 + 1)).toBeNull();
    expect(members.list()).toEqual([ann]);
    expect(members.has("ann")).toBe(true);
    expect(members.invites(T0 + 1)).toEqual([]);

    expect(await members.accept(secret, bob, T0 + 2)).toEqual({ error: expect.stringContaining("expired or was already used") });
    expect(members.has("bob")).toBe(false);
  });

  it("checks an invite without using it up", async () => {
    const members = new ChatMembers(memorySql());
    const { secret } = await invited(members);
    expect(await members.check("0".repeat(64), ann, T0)).toEqual({ error: expect.any(String) });
    expect(await members.check(secret, ann, T0 + INVITE_TTL_MS)).toEqual({ error: expect.any(String) });
    expect(await members.check(secret, ann, T0)).toBeNull();
    expect(members.has("ann")).toBe(false);
    expect(await members.accept(secret, ann, T0)).toBeNull();
    expect(await members.check(secret, bob, T0)).toEqual({ error: expect.stringContaining("already used") });
  });

  it("keeps the invite when someone already in the chat opens it", async () => {
    const members = new ChatMembers(memorySql());
    const first = await invited(members);
    await members.accept(first.secret, ann, T0);
    const second = await invited(members);
    expect(await members.accept(second.secret, ann, T0)).toBeNull();
    expect(await members.accept(second.secret, bob, T0)).toBeNull();
    expect(members.list()).toEqual([ann, bob]);
  });

  it("refuses an expired invite and forgets it", async () => {
    const members = new ChatMembers(memorySql());
    const { secret } = await invited(members);
    expect(await members.accept(secret, ann, T0 + INVITE_TTL_MS)).toEqual({ error: expect.any(String) });
    expect(members.invites(T0 + INVITE_TTL_MS)).toEqual([]);
    expect(members.list()).toEqual([]);
  });

  it("refuses a revoked invite and a made-up secret", async () => {
    const members = new ChatMembers(memorySql());
    const { invite, secret } = await invited(members);
    expect(await members.accept("0".repeat(64), ann, T0)).toEqual({ error: expect.any(String) });
    expect(members.revokeInvite(invite.id)).toBe(true);
    expect(members.revokeInvite(invite.id)).toBe(false);
    expect(await members.accept(secret, ann, T0)).toEqual({ error: expect.any(String) });
  });

  it("stores only a hash of the secret", async () => {
    const sql = memorySql();
    const { secret } = await invited(new ChatMembers(sql));
    const rows = JSON.stringify(sql.db.prepare("SELECT * FROM chat_invites").all());
    expect(rows).not.toContain(secret);
  });

  it("caps the open invites", async () => {
    const members = new ChatMembers(memorySql());
    for (let n = 0; n < MAX_OPEN_INVITES; n++) await invited(members);
    expect(await members.createInvite(T0)).toEqual({ error: expect.stringContaining("revoke one") });
    // Expired ones no longer count.
    expect("error" in (await members.createInvite(T0 + INVITE_TTL_MS))).toBe(false);
  });

  it("removes and renames members", async () => {
    const members = new ChatMembers(memorySql());
    await members.accept((await invited(members)).secret, ann, T0);
    members.rename({ uid: "ann", name: "ann@example.org" });
    expect(members.list()).toEqual([{ uid: "ann", name: "ann@example.org" }]);
    expect(members.remove("ann")).toEqual({ uid: "ann", name: "ann@example.org" });
    expect(members.remove("ann")).toBeUndefined();
    expect(members.list()).toEqual([]);
  });

  it("names the owner by their uid until they show a name", () => {
    const members = new ChatMembers(memorySql());
    expect(members.ownerName("owner1")).toBe("owner1");
    members.setOwnerName({ uid: "owner1", name: "owner@example.com" });
    expect(members.ownerName("owner1")).toBe("owner@example.com");
  });

  it("keeps its tables across instances on the same storage", async () => {
    const sql = memorySql();
    await new ChatMembers(sql).accept((await invited(new ChatMembers(sql))).secret, ann, T0);
    expect(new ChatMembers(sql).list()).toEqual([ann]);
  });
});

describe("the owner's second seat", () => {
  it("joins with no invite and leaves like any member", async () => {
    const members = new ChatMembers(memorySql());
    const seat = secondSeat(ann);
    expect(seat).toEqual({ uid: secondSeatUid("ann"), name: "ann@example.com (2)" });
    expect(members.add(seat, T0)).toBeNull();
    expect(members.list()).toEqual([seat]);
    expect(members.invites(T0)).toEqual([]);
    expect(members.remove(seat.uid)).toEqual(seat);
    expect(members.hasAny()).toBe(false);
  });

  it("counts toward the members a chat can have", async () => {
    const members = new ChatMembers(memorySql());
    for (let i = 0; i < 20; i++) expect(members.add({ uid: `m${i}`, name: `m${i}` }, T0 + i)).toBeNull();
    expect(members.add(secondSeat(ann), T0 + 20)).toEqual({ error: expect.stringContaining("the most there can be") });
  });

  it("has a uid that is a valid uid and never anyone's own", () => {
    const access = "0123456789abcdef0123456789abcdef";
    expect(secondSeatUid(access)).toMatch(UID_PATTERN);
    // Access uids are hex: a seat's has a dash, so no one signs in as it.
    expect(secondSeatUid(access)).not.toMatch(/^[a-f0-9]+$/);
    expect(secondSeatUid(access)).not.toBe(secondSeatUid("fedcba9876543210fedcba9876543210"));
  });
});

describe("invite tokens", () => {
  const token = { ownerUid: "owner-1", chatId: "0123456789abcdef", secret: "a".repeat(64) };

  it("round-trips", () => {
    expect(parseInviteToken(formatInviteToken(token))).toEqual(token);
  });

  it.each([
    ["not a string", 42],
    ["a missing part", "owner-1.0123456789abcdef"],
    ["an extra part", `${formatInviteToken(token)}.x`],
    ["a bad uid", formatInviteToken({ ...token, ownerUid: "Owner" })],
    ["a bad chat id", formatInviteToken({ ...token, chatId: "abc" })],
    ["a short secret", formatInviteToken({ ...token, secret: "a".repeat(63) })],
  ])("rejects %s", (_, value) => {
    expect(parseInviteToken(value)).toBeNull();
  });
});
