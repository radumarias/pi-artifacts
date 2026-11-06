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
  let onAbort: (() => void) | undefined;
  const stop = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
    onAbort = () => reject(signal!.reason ?? new Error("Stopped."));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([promise, stop]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort!);
  });
}
