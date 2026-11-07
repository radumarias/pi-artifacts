import { useCallback, useEffect, useRef, useState } from "react";
import type { MentionNotice, RunsNotice, SidebarList } from "../shared/protocol.ts";
import type { SignInNotice } from "../shared/sign-ins.ts";
import { isObject, text } from "../shared/util.ts";
import { api, keepAlive } from "./api.ts";

/** One prompt changes a list several times in a row (bumped, working, named, done): read it once for those. */
const LOAD_DELAY_MS = 150;
const LISTS: readonly SidebarList[] = ["chats", "artifacts", "skills", "agents", "sign-ins"];
/**
 * The window event the sidebar's socket raises when a run of one of the user's agents moved on (detail: its id), or,
 * as it opens again, when any may have while it was closed (detail: null).
 */
export const RUNS_EVENT = "pi-agent-runs";

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
 * A list with no loader is one this view does not show. `onMention` hears when someone tags the user in a shared chat,
 * `onSignIn` when a sign-in to a server needs them (shared/sign-ins.ts).
 */
export function useSidebarSocket(
  loaders: Partial<Record<SidebarList, () => void>>,
  onMention?: (notice: MentionNotice) => void,
  onSignIn?: (notice: SignInNotice) => void,
): void {
  const current = useRef(loaders);
  current.current = loaders;
  const mentioned = useRef(onMention);
  mentioned.current = onMention;
  const signIn = useRef(onSignIn);
  signIn.current = onSignIn;

  useEffect(() => {
    const pending = new Map<string, ReturnType<typeof setTimeout>>();
    // Once per burst for each key: a list's load, or an agent's runs.
    const later = (key: string, then: () => void) => {
      clearTimeout(pending.get(key));
      pending.set(
        key,
        setTimeout(() => {
          pending.delete(key);
          then();
        }, LOAD_DELAY_MS),
      );
    };
    const load = (list: SidebarList) => later(list, () => current.current[list]?.());
    let closed = false;
    let reopened = false;
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
        // Notices of runs sent while it was closed are lost: an open Runs tab reads again.
        if (reopened) later("runs", () => dispatchEvent(new CustomEvent(RUNS_EVENT, { detail: null })));
        reopened = true;
      };
      ws.onmessage = (event) => {
        if (LISTS.includes(event.data)) return load(event.data);
        const notice = parseNotice(event.data);
        if (notice?.type === "mention") mentioned.current?.(notice);
        else if (notice?.type === "sign-in") signIn.current?.(notice);
        else if (notice?.type === "runs") {
          const { agentId } = notice;
          later(`runs:${agentId}`, () => dispatchEvent(new CustomEvent(RUNS_EVENT, { detail: agentId })));
        }
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

function parseNotice(data: unknown): MentionNotice | RunsNotice | SignInNotice | null {
  try {
    const notice: unknown = typeof data === "string" ? JSON.parse(data) : null;
    if (!isObject(notice)) return null;
    const agentId = notice.type === "runs" ? text(notice.agentId) : undefined;
    if (agentId) return { type: "runs", agentId };
    if (notice.type === "mention" && text(notice.chatId)) return notice as unknown as MentionNotice;
    return notice.type === "sign-in" && text(notice.server) && text(notice.link) ? (notice as unknown as SignInNotice) : null;
  } catch {
    return null;
  }
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
