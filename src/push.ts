import { fromBase64url, memoAsync } from "../shared/util.ts";
import { api } from "./api.ts";

/**
 * Web Push in this browser: once the user allowed notifications, the app registers its service worker (public/sw.js)
 * and subscribes with the Worker's VAPID key, so a notice reaches them while the app is closed. Without push in the
 * browser, or on the Worker (no VAPID secrets), it does nothing: the app's own notices still show while it is open.
 */
const supported = typeof navigator !== "undefined" && "serviceWorker" in navigator && typeof window !== "undefined" && "PushManager" in window;

let enabling: Promise<void> | undefined;
/** Who is signed in to this window (setPushUser): a subscription is made for them alone. */
let user: string | undefined;
/** Which user this browser's subscription was made for, kept across sessions. */
const SUBSCRIBED_FOR = "push.uid";

/** The signed-in user: subscribes this browser for them when notifications are allowed already. */
export function setPushUser(uid: string): void {
  user = uid;
  if (supported && Notification.permission === "granted") void enablePush();
}

/**
 * Subscribe this browser for the signed-in user, once per page load; a subscription made for another key, or for
 * another user (one whose session ended without signing out here), is replaced. Failures are logged.
 */
export function enablePush(): Promise<void> {
  if (!supported || !user) return Promise.resolve();
  enabling ??= subscribe(user).catch((error: unknown) => {
    enabling = undefined;
    console.warn("push:", error);
  });
  return enabling;
}

/** The Worker's VAPID key, or null when it sends no pushes: read once per page load (again after a failure). */
const pushKey = memoAsync(() => api.pushKey());

/** Whether a notice can reach this browser while the app is closed: push here, and on the Worker (its VAPID key). */
export function pushAvailable(): Promise<boolean> {
  return supported
    ? pushKey().then(
        (key) => key !== null,
        () => false,
      )
    : Promise.resolve(false);
}

async function subscribe(uid: string): Promise<void> {
  const key = await pushKey();
  if (!key) return;
  await navigator.serviceWorker.register("/sw.js");
  // A worker registered just now is still installing, and only an active one can subscribe.
  const registration = await navigator.serviceWorker.ready;
  const serverKey = fromBase64url(key);
  let subscription = await registration.pushManager.getSubscription();
  // Another user's subscription is ended at the push service, so their directory forgets it on its next push (410).
  if (subscription && (!sameKey(subscription.options.applicationServerKey, serverKey) || stored(SUBSCRIBED_FOR) !== uid)) {
    await forget(subscription);
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey });
  store(SUBSCRIBED_FOR, uid);
  await api.subscribePush(subscription.toJSON());
}

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Without storage, a later page load cannot tell whose it is and makes a new subscription; nothing else is lost.
  }
}

/**
 * Stop pushes to this browser, before its user signs out: the next person to sign in here must not get theirs. Waits at
 * most a moment, so signing out never hangs on it.
 */
export async function disablePush(): Promise<void> {
  if (!supported) return;
  const pending = enabling;
  enabling = undefined;
  const unsubscribe = async () => {
    const subscription = await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription();
    if (subscription) await forget(subscription);
  };
  const stop = (async () => {
    await unsubscribe();
    // A subscribe still going may finish after that, and subscribe the browser again: undo it too.
    if (pending) {
      await pending;
      await unsubscribe();
    }
  })().catch((error: unknown) => console.warn("push:", error));
  await Promise.race([stop, new Promise((resolve) => setTimeout(resolve, 2_000))]);
}

/**
 * Unsubscribe in the browser, then tell the Worker to forget the endpoint. The browser goes first: on a slow network the
 * Worker's answer may never come before sign-out moves on, and the push service refuses an ended subscription anyway (the
 * Worker then forgets it).
 */
async function forget(subscription: PushSubscription): Promise<void> {
  const { endpoint } = subscription;
  await subscription.unsubscribe();
  await api.unsubscribePush(endpoint).catch(() => {});
}

/** A click on a pushed notification, in an open window: the service worker asks it to go to `url` (an app path). */
export function onPushOpen(navigate: (path: string) => void): () => void {
  if (!supported) return () => {};
  const listener = (event: MessageEvent) => {
    const data = event.data as { type?: unknown; url?: unknown } | null;
    if (
      data?.type === "open" &&
      typeof data.url === "string" &&
      /^\/(?![/\\])/.test(data.url) &&
      // No backslash, space or control character: URL parsing drops some ("/\t/x" is "//x", another site).
      !/[\\\x00-\x20]/.test(data.url) &&
      !data.url.startsWith("/api/")
    )
      navigate(data.url);
  };
  navigator.serviceWorker.addEventListener("message", listener);
  return () => navigator.serviceWorker.removeEventListener("message", listener);
}

/**
 * Show a notice as the system's notification from the open app. Where the page may not (Android shows only a service
 * worker's), the service worker shows it, and a click opens `url` (an app path) instead of calling `onClick`.
 */
export async function showNotification(title: string, options: NotificationOptions & { url: string; onClick: () => void }): Promise<void> {
  const { onClick, url, ...shown } = options;
  try {
    const shownHere = new Notification(title, shown);
    shownHere.onclick = () => {
      window.focus();
      onClick();
      shownHere.close();
    };
  } catch {
    const registration = supported ? await navigator.serviceWorker.getRegistration() : undefined;
    await registration?.showNotification(title, { ...shown, data: { url } });
  }
}

function sameKey(current: ArrayBuffer | null, key: Uint8Array): boolean {
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return bytes.length === key.length && bytes.every((byte, i) => byte === key[i]);
}
