import { ID_PATTERN, UID_PATTERN, type ChatInvite, type Person } from "../shared/protocol.ts";
import { randomHex, sha256Hex } from "../shared/util.ts";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_MEMBERS = 20;
export const MAX_OPEN_INVITES = 20;

/** The part of a Durable Object's SQL API the tables here need; the tests put node:sqlite behind it. */
export interface Sql {
  exec(query: string, ...bindings: (string | number | null)[]): { toArray(): Record<string, unknown>[]; rowsWritten: number };
}

/** An invite link's token: the chat it opens and a secret the chat keeps only the hash of. */
interface InviteToken {
  ownerUid: string;
  chatId: string;
  secret: string;
}

const SECRET_PATTERN = /^[a-f0-9]{64}$/;

export function formatInviteToken({ ownerUid, chatId, secret }: InviteToken): string {
  return `${ownerUid}.${chatId}.${secret}`;
}

/** The parts of a token, or null for anything that is not one. Uids and chat ids never contain dots. */
export function parseInviteToken(token: unknown): InviteToken | null {
  if (typeof token !== "string") return null;
  const [ownerUid, chatId, secret, ...rest] = token.split(".");
  if (rest.length || !UID_PATTERN.test(ownerUid ?? "") || !ID_PATTERN.test(chatId ?? "") || !SECRET_PATTERN.test(secret ?? "")) return null;
  return { ownerUid, chatId, secret };
}

/**
 * One chat's members and open invites, in the chat object's own SQLite. The
 * owner is not a member: the chat object's name says who owns it. An invite
 * is single-use and expires; the table keeps only its secret's hash, so the
 * link is shown once, when it is made.
 */
export class ChatMembers {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS chat_members (uid TEXT PRIMARY KEY, name TEXT NOT NULL, joined_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_invites (secret_hash TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_owner (uid TEXT PRIMARY KEY, name TEXT NOT NULL);
    `);
  }

  /** The owner's name as they last showed it; their uid if they never did. */
  ownerName(ownerUid: string): string {
    const row = this.#sql.exec("SELECT name FROM chat_owner WHERE uid = ?", ownerUid).toArray()[0];
    return (row?.name as string | undefined) ?? ownerUid;
  }

  /** Only a changed name is written: this runs on every connect. */
  setOwnerName(owner: Person): void {
    this.#sql.exec(
      "INSERT INTO chat_owner (uid, name) VALUES (?, ?) ON CONFLICT(uid) DO UPDATE SET name = excluded.name WHERE name <> excluded.name",
      owner.uid,
      owner.name,
    );
  }

  list(): Person[] {
    return this.#sql
      .exec("SELECT uid, name FROM chat_members ORDER BY joined_at")
      .toArray()
      .map((row) => ({ uid: row.uid as string, name: row.name as string }));
  }

  has(uid: string): boolean {
    return this.#sql.exec("SELECT 1 FROM chat_members WHERE uid = ?", uid).toArray().length > 0;
  }

  hasAny(): boolean {
    return this.#count("chat_members") > 0;
  }

  /** A member's name changes when they sign in with another email for the same uid; keep the one they last used. */
  rename(member: Person): void {
    this.#sql.exec("UPDATE chat_members SET name = ? WHERE uid = ? AND name <> ?", member.name, member.uid, member.name);
  }

  #count(table: "chat_members" | "chat_invites"): number {
    return this.#sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).toArray()[0].n as number;
  }

  #full(): { error: string } | null {
    return this.#count("chat_members") >= MAX_MEMBERS ? { error: `This chat has ${MAX_MEMBERS} members, the most there can be.` } : null;
  }

  /** The member removed, or undefined when `uid` was not one. */
  remove(uid: string): Person | undefined {
    const row = this.#sql.exec("DELETE FROM chat_members WHERE uid = ? RETURNING uid, name", uid).toArray()[0];
    return row && { uid: row.uid as string, name: row.name as string };
  }

  /** The invites still open, oldest first. A read only: it runs on every connect; createInvite forgets the expired ones. */
  invites(now = Date.now()): ChatInvite[] {
    return this.#sql
      .exec("SELECT id, created_at, expires_at FROM chat_invites WHERE expires_at > ? ORDER BY created_at", now)
      .toArray()
      .map((row) => ({ id: row.id as string, createdAt: row.created_at as number, expiresAt: row.expires_at as number }));
  }

  /** A new invite and its secret, which only the link carries. */
  async createInvite(now = Date.now()): Promise<{ invite: ChatInvite; secret: string } | { error: string }> {
    const secret = randomHex(32);
    const secretHash = await sha256Hex(secret);
    // After the await, as in accept: the checks and the insert happen in one step of the object.
    this.#sql.exec("DELETE FROM chat_invites WHERE expires_at <= ?", now);
    if (this.#count("chat_invites") >= MAX_OPEN_INVITES) return { error: `This chat has ${MAX_OPEN_INVITES} open invites; revoke one first.` };
    const full = this.#full();
    if (full) return full;
    const invite = { id: randomHex(8), createdAt: now, expiresAt: now + INVITE_TTL_MS };
    this.#sql.exec("INSERT INTO chat_invites (secret_hash, id, created_at, expires_at) VALUES (?, ?, ?, ?)", secretHash, invite.id, invite.createdAt, invite.expiresAt);
    return { invite, secret };
  }

  revokeInvite(id: string): boolean {
    return this.#sql.exec("DELETE FROM chat_invites WHERE id = ?", id).rowsWritten > 0;
  }

  /** What accept would answer now, without using the invite up. */
  async check(secret: string, person: Person, now = Date.now()): Promise<{ error: string } | null> {
    const secretHash = await sha256Hex(secret);
    return this.has(person.uid) ? null : this.#refusal(secretHash, now);
  }

  /** Why an invite cannot be used by someone not yet in the chat, or null when it can. */
  #refusal(secretHash: string, now: number): { error: string } | null {
    const row = this.#sql.exec("SELECT expires_at FROM chat_invites WHERE secret_hash = ?", secretHash).toArray()[0];
    if (!row || (row.expires_at as number) <= now) return { error: "This invite link has expired or was already used. Ask for a new one." };
    return this.#full();
  }

  /**
   * Use an invite: `person` becomes a member and the invite is gone. Someone
   * already in the chat keeps the invite unused, so it can still go to whoever
   * it was meant for. The chat lets its owner in before this. Null when they are in.
   */
  async accept(secret: string, person: Person, now = Date.now()): Promise<{ error: string } | null> {
    const secretHash = await sha256Hex(secret);
    // After the await: nothing below awaits, so the check and the change happen in one step of the object.
    if (this.has(person.uid)) return null;
    const refused = this.#refusal(secretHash, now);
    if (refused) return refused;
    this.#sql.exec("DELETE FROM chat_invites WHERE secret_hash = ?", secretHash);
    this.#sql.exec("INSERT INTO chat_members (uid, name, joined_at) VALUES (?, ?, ?)", person.uid, person.name, now);
    return null;
  }
}
