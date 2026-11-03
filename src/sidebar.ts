import { useCallback, useEffect, useRef, useState } from "react";
import type { SidebarList } from "../shared/protocol.ts";
import { api, keepAlive } from "./api.ts";

/** One prompt changes a list several times in a row (bumped, working, named, done): read it once for those. */
const LOAD_DELAY_MS = 150;
const LISTS: readonly SidebarList[] = ["chats", "artifacts", "skills"];

/**
 * A value read by `read`, and a stable `load` that reads it again. Reads can overlap: only the newest one's answer is
 * kept, so a slow older read cannot put back a stale list. A failed read keeps what there is; `onError`, if given,
 * hears the newest read's error, or null once a read succeeds.
 */
export function useLatest<T>(
  read: () => Promise<T>,
  initial: T,
  onError?: (error: Error | null) => void,
): [T, () => void, (update: (value: T) => T) => void] {
  const [value, setValue] = useState(initial);
  const reads = useRef(0);
  const reader = useRef(read);
  reader.current = read;
  const errors = useRef(onError);
  errors.current = onError;
  const load = useCallback(() => {
    const n = ++reads.current;
    reader.current().then(
      (next) => {
        if (n !== reads.current) return;
        setValue(next);
        errors.current?.(null);
      },
      (error: Error) => n === reads.current && errors.current?.(error),
    );
  }, []);
  return [value, load, setValue];
}

/**
 * The sidebar's socket: the server names a list whenever it changed (a chat named or working, an artifact published,
 * a skill proposed, in any window or by anyone in a shared chat), and `loaders` reads it again, at most once per short
 * burst of changes. Every (re)connect reads all of them: whatever changed while it was closed, or before it opened.
 */
export function useSidebarSocket(loaders: Record<SidebarList, () => void>): void {
  const current = useRef(loaders);
  current.current = loaders;

  useEffect(() => {
    const pending = new Map<SidebarList, ReturnType<typeof setTimeout>>();
    const load = (list: SidebarList) => {
      clearTimeout(pending.get(list));
      pending.set(
        list,
        setTimeout(() => {
          pending.delete(list);
          current.current[list]();
        }, LOAD_DELAY_MS),
      );
    };
    let closed = false;
    let attempt = 0;
    let ws: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      ws = new WebSocket(api.sidebarSocketUrl());
      // Pings only while the socket is open, and stops when it closes.
      keepAlive(ws);
      ws.onopen = () => {
        attempt = 0;
        LISTS.forEach(load);
      };
      ws.onmessage = (event) => {
        if (LISTS.includes(event.data)) load(event.data);
      };
      ws.onclose = () => {
        if (!closed) retry = setTimeout(open, Math.min(1_000 * 2 ** attempt++, 30_000));
      };
    };
    // On the next tick, as the chat's socket does: a mount undone at once opens nothing.
    retry = setTimeout(open);
    return () => {
      closed = true;
      clearTimeout(retry);
      pending.forEach((timer) => clearTimeout(timer));
      ws?.close();
    };
  }, []);
}

export function useVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}
