import { CURRENT_SQLITE_SCHEMA_VERSION } from "@earendil-works/pi-durable/storage/sqlite";
import { CHAT_PART_BYTES, type ChatDumpCursor, type ChatDumpPage, type ChatDumpPart, type SqlCell, type SqlRow } from "../shared/data-export.ts";
import { fromBase64, toBase64 } from "../shared/util.ts";

/** The part of a Durable Object's SQL API a dump needs; the tests put node:sqlite behind it. */
export interface DumpSql {
  exec(query: string, ...bindings: (string | number | null | ArrayBuffer)[]): { toArray(): Record<string, unknown>[] };
}

/** The part of a Durable Object's KV API a dump needs. */
export interface DumpKv {
  get(key: string): unknown;
  put(key: string, value: unknown): void;
  delete(key: string): unknown;
}

/**
 * What of a chat object's storage an export carries: its conversation (pi's tables, `pi_…`), its reactions and its
 * owner's name. Not its members and invites: they are people of the deployment it was made on, whose ids mean nothing
 * on another, so an imported chat starts with nobody in it but its owner. Nor the Lifecycle's jobs (`cf_agents_…`).
 */
const APP_TABLES = ["chat_reactions", "chat_owner"];
const PI_TABLE = /^pi_[a-z0-9_]+$/;
const isCarried = (table: string) => PI_TABLE.test(table) || APP_TABLES.includes(table);

/**
 * Rows of pi's tables that are work still to do (a run, a tool call, a message waiting for one) are left out: on
 * another deployment they would run as the importer, with their sign-ins, unasked. An imported chat is idle.
 */
const FINISHED: Record<string, string> = {
  pi_tasks: "status = 'terminal'",
  pi_submissions: "status IN ('done', 'unanswered')",
};

const ROWS_AT_ONCE = 200;
const ROWID = "__dump_rowid";

/** The tables an export carries, in a stable order (a cursor names one by its place). */
function carriedTables(sql: DumpSql): string[] {
  return sql
    .exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .toArray()
    .map((row) => String(row.name))
    .filter(isCarried);
}

/**
 * One part of a chat's storage, from `cursor` on, about CHAT_PART_BYTES of it (one row more, so a large row still
 * fits a part of its own), and where the next part starts. The first part holds the chat's settings (`kvKeys` of `kv`),
 * and each table's schema comes with its first rows.
 */
export function dumpChat(
  sql: DumpSql,
  kv: DumpKv,
  kvKeys: readonly string[],
  cursor: ChatDumpCursor = { table: 0, after: 0 },
  budget = CHAT_PART_BYTES,
): ChatDumpPage {
  const part: ChatDumpPart = { tables: [] };
  let bytes = 0;
  if (cursor.table === 0 && cursor.after === 0) {
    part.kv = Object.fromEntries(kvKeys.flatMap((key) => (kv.get(key) === undefined ? [] : [[key, kv.get(key)]])));
    bytes += JSON.stringify(part.kv).length;
  }
  const tables = carriedTables(sql);
  for (let t = cursor.table; t < tables.length; t++) {
    const name = tables[t];
    let after = t === cursor.table ? cursor.after : 0;
    const entry: ChatDumpPart["tables"][number] = { name, rows: [] };
    if (after === 0) {
      entry.schema = sql
        .exec("SELECT sql FROM sqlite_master WHERE tbl_name = ? AND sql IS NOT NULL ORDER BY type DESC, name", name)
        .toArray()
        .map((row) => String(row.sql));
    }
    part.tables.push(entry);
    const filter = FINISHED[name] ? ` AND ${FINISHED[name]}` : "";
    for (;;) {
      const rows = sql.exec(`SELECT rowid AS ${ROWID}, * FROM "${name}" WHERE rowid > ?${filter} ORDER BY rowid LIMIT ${ROWS_AT_ONCE}`, after).toArray();
      for (const row of rows) {
        after = Number(row[ROWID]);
        const cells: SqlRow = {};
        for (const [column, value] of Object.entries(row)) if (column !== ROWID) cells[column] = toCell(value);
        entry.rows.push(cells);
        bytes += JSON.stringify(cells).length;
        if (bytes >= budget) return { part, next: { table: t, after } };
      }
      if (rows.length < ROWS_AT_ONCE) break;
    }
  }
  return { part };
}

function toCell(value: unknown): SqlCell {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return { b64: toBase64(bytes) };
  }
  if (typeof value === "bigint") return Number(value);
  return value as SqlCell;
}

/** A part of an import that cannot be stored as it is. */
export class DumpError extends Error {}

/** Whether the chat object has a conversation: pi made its tables, which it does when the chat first opens. */
export function hasConversation(sql: DumpSql): boolean {
  return carriedTables(sql).some((name) => PI_TABLE.test(name));
}

/** pi-durable's own record of its schema's version: an export from a newer pi than this deployment's cannot be read here. */
const PI_SCHEMA = "pi_durable_schema";

/** Drop what an import that stopped part way wrote, so that it can start again: the carried tables' rows and the settings. */
export function clearImported(sql: DumpSql, kv: DumpKv, kvKeys: readonly string[]): void {
  for (const name of carriedTables(sql)) {
    if (PI_TABLE.test(name)) sql.exec(`DROP TABLE "${name}"`);
    else sql.exec(`DELETE FROM "${name}"`);
  }
  for (const key of kvKeys) kv.delete(key);
}

/**
 * Store one part of a chat's storage (dumpChat) in this, a chat object with no conversation yet: a table it lacks is
 * made from the part's schema, which may only make that table and its indexes. `remap` changes the ids in its text
 * (shared/data-export.ts idRemapper). A row stored before (an import that stopped part way, a request sent again) is
 * replaced. Throws a DumpError for a part that does not fit.
 */
export function restorePart(sql: DumpSql, kv: DumpKv, kvKeys: readonly string[], part: ChatDumpPart, remap: (text: string) => string): void {
  for (const [key, value] of Object.entries(part.kv ?? {})) {
    if (kvKeys.includes(key) && value !== undefined) kv.put(key, JSON.parse(remap(JSON.stringify(value))));
  }
  for (const { name, schema, rows } of part.tables ?? []) {
    if (!isCarried(name)) throw new DumpError(`An export does not carry a table named ${JSON.stringify(name)}.`);
    let columns = tableColumns(sql, name);
    if (!columns.size) {
      for (const statement of schema ?? []) sql.exec(checkSchema(statement, name));
      columns = tableColumns(sql, name);
      if (!columns.size) throw new DumpError(`The export has no schema for ${name}.`);
    }
    for (const row of rows) {
      if (name === PI_SCHEMA && Number(row.version) > CURRENT_SQLITE_SCHEMA_VERSION) {
        throw new DumpError("The chat comes from a newer version of the app; update this deployment first.");
      }
      const names = Object.keys(row);
      const unknown = names.find((column) => !columns.has(column));
      if (unknown !== undefined || !names.length) throw new DumpError(`${name} has no column ${JSON.stringify(unknown ?? "")}.`);
      const values = names.map((column) => fromCell(row[column], remap));
      sql.exec(`INSERT OR REPLACE INTO "${name}" (${names.map((column) => `"${column}"`).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`, ...values);
    }
  }
}

function tableColumns(sql: DumpSql, table: string): Set<string> {
  return new Set(
    sql
      .exec("SELECT name FROM pragma_table_info(?)", table)
      .toArray()
      .map((row) => String(row.name)),
  );
}

const IDENTIFIER = /^"?([A-Za-z0-9_]+)"?$/;

/**
 * A statement of a table's schema, as SQLite keeps it (sqlite_master), if it makes `table` or an index on it and
 * nothing else: one statement, no trigger, no view.
 */
function checkSchema(statement: string, table: string): string {
  const refused = new DumpError(`The schema the export gives for ${table} is not one this app writes.`);
  if (typeof statement !== "string" || statement.includes(";")) throw refused;
  const made = statement.match(/^CREATE\s+TABLE\s+([^\s(]+)\s*\(/);
  const indexed = statement.match(/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+\S+\s+ON\s+([^\s(]+)\s*\(/);
  const target = (made ?? indexed)?.[1].match(IDENTIFIER)?.[1];
  if (target !== table) throw refused;
  return statement;
}

function fromCell(cell: SqlCell | undefined, remap: (text: string) => string): string | number | null | ArrayBuffer {
  if (cell === null || cell === undefined || typeof cell === "number") return cell ?? null;
  if (typeof cell === "string") return remap(cell);
  if (typeof cell === "object" && typeof cell.b64 === "string") return fromBase64(cell.b64).buffer;
  throw new DumpError("A cell of the export is not one SQLite stores.");
}
