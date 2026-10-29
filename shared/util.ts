/** The message of anything thrown. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Lowercase hex of some bytes. */
export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
