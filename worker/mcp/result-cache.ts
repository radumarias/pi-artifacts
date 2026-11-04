import type { CallToolResult } from "../../shared/protocol.ts";

export interface CachedResult {
  result: CallToolResult;
  /** When the result was produced upstream (epoch ms). */
  storedAt: number;
}

interface Entry extends CachedResult {
  /** About how much memory the result holds: its JSON length. */
  bytes: number;
}

/**
 * Tool results by key, within a byte budget. Callers decide how young a result must be; entries older than
 * `lifetimeMs` only go first when room is needed.
 */
export class ResultCache {
  readonly #entries = new Map<string, Entry>();
  #bytes = 0;

  constructor(
    readonly maxBytes: number,
    readonly lifetimeMs: number,
    readonly now: () => number = Date.now,
  ) {}

  get(key: string): CachedResult | undefined {
    return this.#entries.get(key);
  }

  /**
   * Keep a result within the budget. Entries are re-inserted on every store, so the map runs oldest first: expired
   * entries go from the front, then the oldest until the new one fits. A result bigger than the whole budget is not kept.
   */
  set(key: string, result: CallToolResult, storedAt: number): void {
    this.#evict(key);
    const bytes = JSON.stringify(result).length;
    if (bytes > this.maxBytes) return;
    const now = this.now();
    for (const [k, e] of this.#entries) {
      if (now - e.storedAt <= this.lifetimeMs && this.#bytes + bytes <= this.maxBytes) break;
      this.#evict(k);
    }
    this.#entries.set(key, { result, storedAt, bytes });
    this.#bytes += bytes;
  }

  #evict(key: string): void {
    const entry = this.#entries.get(key);
    if (!entry) return;
    this.#entries.delete(key);
    this.#bytes -= entry.bytes;
  }
}
