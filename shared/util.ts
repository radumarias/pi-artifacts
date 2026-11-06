/** A JSON object, read leniently: every field may be missing. */
export type Json = Record<string, unknown>;

/** Whether `value` is a JSON object (not null, not an array). */
export function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `value` when it is a non-empty string. */
export function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** The message of anything thrown. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `value` cut to `max` characters, saying how many were cut. */
export function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n… [${value.length - max} more characters cut]`;
}

/** Lowercase hex of some bytes. */
export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Lowercase hex of the SHA-256 of a string's UTF-8 bytes. */
export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** `n` random bytes as lowercase hex. */
export function randomHex(n: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(n)));
}

/**
 * `fn` of each item, in order, with at most `limit` running at once. Once one fails no more start, and it throws that
 * failure only when those running have settled: nothing is still going when the caller cleans up after it.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    try {
      for (let i = next++; i < items.length && !failed; i = next++) results[i] = await fn(items[i]);
    } catch (error) {
      failed = true;
      throw error;
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, worker));
  const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (rejected) throw rejected.reason;
  return results;
}

/** Standard base64 of `bytes`, built in chunks: a spread of a large array would overflow the call stack. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** The bytes of standard base64. */
export function fromBase64(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

/** `fn`'s result, computed once and shared; a failure is forgotten, so the next call tries again. */
export function memoAsync<T>(fn: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () =>
    (value ??= fn().catch((error) => {
      value = undefined;
      throw error;
    }));
}

/** `fn`, with concurrent calls sharing the run in flight; the next call after it settles runs `fn` again. */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | undefined;
  return () =>
    (running ??= fn().finally(() => {
      running = undefined;
    }));
}

/**
 * `fn` run one call at a time, in the order called: a call waits for the one before it to settle, whether it resolved
 * or rejected. Each call gets its own result.
 */
export function serial<A extends unknown[], T>(fn: (...args: A) => Promise<T>): (...args: A) => Promise<T> {
  let last: Promise<unknown> = Promise.resolve();
  return (...args) => {
    const next = last.catch(() => {}).then(() => fn(...args));
    last = next;
    return next;
  };
}

/** A size people read: "512 B", "2.0 KB", "10.0 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The first `max` items joined with ", ", then how many more there are: "a, b and 3 more". */
export function listSome(items: readonly string[], max: number): string {
  const shown = items.slice(0, max).join(", ");
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}

/** A count and its noun, plural when it is not one: "1 error", "3 errors". */
export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** `promise`, or a rejection once `ms` passed or `signal` aborted, whichever comes first. */
export function deadline<T>(promise: Promise<T>, ms: number, onTimeout: () => Error, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return abortable(Promise.race([promise, timeout]), signal).finally(() => clearTimeout(timer));
}

/** `promise`, or a rejection once `signal` aborted (at once for one already aborted), whichever comes first. */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("Stopped."));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([promise, stop]).finally(() => signal.removeEventListener("abort", onAbort!));
}

/**
 * The JSON value a model's reply holds: all of it, else a fenced block, else from its first brace to its last, else
 * from its first square bracket to its last (each kind apart, so prose such as "[1]" around an object leaves it whole).
 */
export function jsonIn(text: string): unknown {
  const attempts = [text, /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1]];
  for (const [open, close] of [["{", "}"], ["[", "]"]]) {
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start >= 0 && end > start) attempts.push(text.slice(start, end + 1));
  }
  for (const attempt of attempts) {
    if (attempt === undefined) continue;
    try {
      return JSON.parse(attempt.trim());
    } catch {}
  }
  return undefined;
}
