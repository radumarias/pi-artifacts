import { useSyncExternalStore } from "react";
import { findFollow, type FeedList, type FollowKind, type FollowView } from "../../shared/feed.ts";
import { errorMessage } from "../../shared/util.ts";
import { api } from "../api.ts";

interface Loaded<T> {
  value: T | null;
  error: string | null;
  /** Counts the reads that answered: a view keyed on it reads its own list again when the feed changed. */
  version: number;
}

/**
 * A value the app reads from the Worker and shares between views: read when first watched, and again whenever `load`
 * is called (the sidebar's socket says it changed). One read at a time; asked again meanwhile, it reads once more after.
 */
function shared<T>(read: () => Promise<T>) {
  let state: Loaded<T> = { value: null, error: null, version: 0 };
  let reading: Promise<void> | undefined;
  let again = false;
  const listeners = new Set<() => void>();
  const set = (next: Loaded<T>) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const load = (): Promise<void> => {
    if (reading) {
      again = true;
      return reading;
    }
    reading = read().then(
      (value) => set({ value, error: null, version: state.version + 1 }),
      (error: unknown) => set({ ...state, error: errorMessage(error) }),
    );
    return reading.finally(() => {
      reading = undefined;
      if (again) {
        again = false;
        void load();
      }
    });
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (state.value === null && !reading) void load();
      return () => listeners.delete(listener);
    },
    get: () => state,
    load,
    put: (value: T) => set({ value, error: null, version: state.version + 1 }),
  };
}

const counts = shared<Pick<FeedList, "unread" | "needsYou">>(api.feedCounts);
const follows = shared<FollowView[]>(api.follows);

/** Read the feed's counts again, and with them tell open feed views to read their lists (the sidebar socket's "feed"). */
export const reloadFeed = counts.load;
/** Put the counts as a change of the feed answered with them: open feed views read their lists again. */
export const putFeedCounts = counts.put;
export const reloadFollows = follows.load;

/** How many feed items are unread, and of them how many need the user; `version` moves with each read. */
export function useFeedCounts(): Loaded<Pick<FeedList, "unread" | "needsYou">> {
  return useSyncExternalStore(counts.subscribe, counts.get);
}

export function useFollows(): Loaded<FollowView[]> {
  return useSyncExternalStore(follows.subscribe, follows.get);
}

/** Whether the user follows a page or `ownerUid`'s agent, and a way to follow it or stop. */
export function useFollow(kind: FollowKind, id: string, chatId?: string, ownerUid?: string) {
  const { value, error } = useFollows();
  const found = value && findFollow(value, { kind, id, ownerUid });
  const toggle = async () => follows.put(found ? await api.unfollow(found) : await api.follow(kind, id, chatId));
  return { known: value !== null, following: Boolean(found), toggle, error };
}

/** Put the follows as a change answered with them. */
export const putFollows = follows.put;
