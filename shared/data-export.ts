import type { ModelSetting } from "./models.ts";
import { ID_PATTERN, type ArtifactVersion } from "./protocol.ts";
import type { SkillFileInfo } from "./skill-files.ts";
import { SKILL_NAME_PATTERN, type SavedSkillOrigin, type SkillInput } from "./skills.ts";
import { sha256Hex } from "./util.ts";

/**
 * Everything one user has, as one zip they download, and take to the same or another deployment by uploading it there.
 * The browser builds the zip a piece at a time and reads it back the same way (src/data/), so neither way is bound by
 * how much one request to the Worker may carry. Its layout (ARCHIVE):
 *
 *   manifest.json                  ExportManifest: the account, and what else the zip holds
 *   chats/<id>/part-<n>.json       a chat's own storage (ChatDumpPart), in parts
 *   chats/<id>/drafts.json         the pages its agent saved and did not publish (Draft[], worker/storage/drafts.ts)
 *   artifacts/<id>/artifact.json   an artifact's versions (ArtifactMeta)
 *   artifacts/<id>/v<n>.html       each version's page
 *   skills/<name>/<path>           the files of a skill imported as a package
 *   files/<path>                   the user's files
 */
export const EXPORT_FORMAT = "pi-artifacts-export";
export const EXPORT_VERSION = 1;

export const ARCHIVE = {
  manifest: "manifest.json",
  chatPart: (chatId: string, n: number) => `chats/${chatId}/part-${String(n).padStart(4, "0")}.json`,
  chatDrafts: (chatId: string) => `chats/${chatId}/drafts.json`,
  artifactMeta: (id: string) => `artifacts/${id}/artifact.json`,
  artifactPage: (id: string, version: number) => `artifacts/${id}/v${version}.html`,
  skillFile: (skill: string, path: string) => `skills/${skill}/${path}`,
  file: (path: string) => `files/${path}`,
};

/** About as much of a chat's storage as one part holds: well under what one request may carry either way. */
export const CHAT_PART_BYTES = 8 * 1024 * 1024;
/** What one request of an import may carry: a chat's part, a page's version, a skill with its files. */
export const MAX_IMPORT_BODY_BYTES = 60 * 1024 * 1024;
/** The largest file an import stores: one request carries it, and Cloudflare takes at most 100 MB in one. */
export const MAX_IMPORT_FILE_BYTES = 95 * 1024 * 1024;

/** A skill of the user's own, as exported: its fields, whether it is on, and the files of one imported as a package. */
export interface ExportedSkill extends SkillInput {
  origin: SavedSkillOrigin;
  enabled: boolean;
  files?: SkillFileInfo[];
}

/** What one page saved for the user (pi.use("storage")), by key; null: a key they removed (see UserDirectory.pageValues). */
export interface ExportedPageValues {
  artifactId: string;
  values: Record<string, string | null>;
}

export interface ExportedAccount {
  systemPrompt: string;
  model: ModelSetting | null;
  builtinSkillsOff: string[];
  skills: ExportedSkill[];
  pageValues: ExportedPageValues[];
}

/** The settings an import sets, each only where the user has none of their own. */
export type ImportedSettings = Pick<ExportedAccount, "systemPrompt" | "model" | "builtinSkillsOff">;

export interface ExportedChat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** How many parts its storage took (ARCHIVE.chatPart). */
  parts: number;
  /** Whether it was shared: the people in it stay behind (see the README's Export and import). */
  shared?: true;
}

export interface ExportedArtifact {
  id: string;
  title: string;
  chatId: string;
  latest: number;
}

export interface ExportedFile {
  path: string;
  size: number;
}

/** manifest.json. Sign-ins to MCP servers are not in it: they belong to the deployment, and are tokens. */
export interface ExportManifest {
  format: typeof EXPORT_FORMAT;
  version: number;
  exportedAt: number;
  /** The user's id where the export was made: an import puts the importer's own in its place, wherever it appears. */
  uid: string;
  account: ExportedAccount;
  chats: ExportedChat[];
  artifacts: ExportedArtifact[];
  files: ExportedFile[];
  /** The chats others shared with the user, by name only: they are their owners', and stay with them. */
  sharedWithMe: { title: string; ownerName: string }[];
}

/** GET /api/me/export: the manifest before the browser has read the chats (`parts` comes from reading them). */
export type ExportStart = Omit<ExportManifest, "chats"> & { chats: Omit<ExportedChat, "parts">[] };

/** A cell of a SQLite row: bytes as base64, so a part is JSON. */
export type SqlCell = string | number | null | { b64: string };
export type SqlRow = Record<string, SqlCell>;

/** Some of a chat's storage: rows of its tables, with each table's schema the first time the table appears. */
export interface ChatDumpPart {
  /** The chat's settings that are not in its tables (in the first part only). */
  kv?: Record<string, unknown>;
  tables: { name: string; schema?: string[]; rows: SqlRow[] }[];
}

/** Where the next part of a chat's storage starts: a table, and the last rowid read from it. */
export interface ChatDumpCursor {
  table: number;
  after: number;
}

/** One part, and where the next starts (none after the last). GET /api/me/export/chats/:id answers with the part, and the cursor in NEXT_PART_HEADER. */
export interface ChatDumpPage {
  part: ChatDumpPart;
  next?: ChatDumpCursor;
}

/** The header that says where a chat's next part starts, as `<table>.<after>`; none after the last part. */
export const NEXT_PART_HEADER = "x-next-part";

export const formatCursor = ({ table, after }: ChatDumpCursor) => `${table}.${after}`;

export function parseCursor(value: string | null): ChatDumpCursor | undefined {
  const [table, after, ...rest] = (value ?? "").split(".").map(Number);
  return value && !rest.length && Number.isSafeInteger(table) && Number.isSafeInteger(after) && table >= 0 && after >= 0 ? { table, after } : undefined;
}

/** GET /api/me/export/skills/:name: a skill's files, base64. */
export interface ExportedSkillFiles {
  files: { path: string; data: string; binary?: true }[];
}

/** POST /api/me/import/plan's body: the chats and artifacts the zip holds. */
export interface ImportPlanRequest {
  chats: string[];
  artifacts: { id: string; chatId: string }[];
}

/**
 * What importing them does here. A chat the user has already (imported before) is skipped. An artifact keeps its id,
 * unless someone else's artifact has it on this deployment: then it gets the one importedArtifactId gives it.
 * `latest` is how many of its versions are here already (0: none), so an import that stopped part way goes on.
 */
export interface ImportPlan {
  chats: Record<string, "new" | "exists">;
  artifacts: Record<string, { id: string; latest: number } | { error: string }>;
}

/** POST /api/me/import/chats/:id/begin: what to put in place of what, in everything the chat's parts hold. */
export interface ChatImportStart {
  /** The user's id in the export. */
  from: string;
  /** Artifact ids the plan changed: old to new. */
  artifacts: Record<string, string>;
}

/** POST /api/me/import/artifacts/:id/versions: one version, in order, of an artifact of `chatId`. */
export interface ArtifactVersionImport {
  chatId: string;
  title: string;
  createdAt: number;
  version: ArtifactVersion;
  html: string;
}

/** The id an imported artifact gets when its own is someone else's here: the same on every try, so an import can go on. */
export async function importedArtifactId(uid: string, id: string): Promise<string> {
  return (await sha256Hex(`pi-artifacts/import:${uid}:${id}`)).slice(0, 16);
}

/**
 * A function that puts each `to` in place of its `from` in text a chat stores: a user id or an artifact id. Ids of 16
 * characters or more (artifact ids, and user ids when deployed) are random, so they are replaced wherever they appear;
 * shorter ones (the names `pnpm dev`'s demo sign-in makes) only as a whole JSON string or a whole value, never inside
 * other words.
 */
export function idRemapper(pairs: readonly (readonly [string, string])[]): (text: string) => string {
  const changes = pairs.filter(([from, to]) => from && from !== to);
  if (!changes.length) return (text) => text;
  const exact = new Map(changes);
  const escape = (id: string) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(changes.map(([from]) => (from.length >= 16 ? escape(from) : `"${escape(from)}"`)).join("|"), "g");
  return (text) => exact.get(text) ?? text.replace(pattern, (found) => (found.startsWith('"') ? `"${exact.get(found.slice(1, -1))}"` : exact.get(found)!));
}

/** Whether a parsed manifest.json is one this app reads, and the error to show when not. */
export function checkManifest(value: unknown): ExportManifest | { error: string } {
  const manifest = value as Partial<ExportManifest> | null;
  if (manifest?.format !== EXPORT_FORMAT) return { error: "This zip is not an export of this app." };
  if (typeof manifest.version !== "number" || manifest.version > EXPORT_VERSION) {
    return { error: "This export comes from a newer version of the app; update this deployment first." };
  }
  const lists = [manifest.chats, manifest.artifacts, manifest.files, manifest.sharedWithMe];
  if (typeof manifest.uid !== "string" || !manifest.account || !lists.every(Array.isArray)) return { error: "The export's manifest is damaged." };
  // Ids and skill names go into request paths: only ones this app makes.
  const ids = [...manifest.chats!.flatMap((chat) => [chat?.id]), ...manifest.artifacts!.flatMap((artifact) => [artifact?.id, artifact?.chatId])];
  const skills = Array.isArray(manifest.account.skills) ? manifest.account.skills : [];
  if (!ids.every((id) => typeof id === "string" && ID_PATTERN.test(id)) || !skills.every((skill) => SKILL_NAME_PATTERN.test(String(skill?.name)))) {
    return { error: "The export's manifest is damaged." };
  }
  return manifest as ExportManifest;
}
