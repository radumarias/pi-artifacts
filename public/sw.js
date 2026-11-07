// The app's service worker: it shows the push notifications the Worker sends (worker/push/) while the app is closed,
// and a click opens the chat or page the push names. It caches nothing.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

/** A path in this app, never another site: a push says where to go, and only the app's own paths are followed. */
function appPath(url) {
  return typeof url === "string" && /^\/(?![/\\])/.test(url) && !/[\\\x00-\x20]/.test(url) ? url : "/";
}

self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    // Not JSON: show the generic notice.
  }
  const title = typeof message.title === "string" ? message.title : "Something new";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof message.body === "string" ? message.body : "",
      tag: typeof message.tag === "string" ? message.tag : undefined,
      data: { url: appPath(message.url) },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = appPath(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      // A route the Worker serves (a sign-in): a page of its own, which the app cannot show in place.
      if (url.startsWith("/api/")) return self.clients.openWindow(url);
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // A window of the app itself, any of its pages, which moves there without a reload (src/push.ts), the focused one
      // first. Not a page the Worker serves (a sign-in's result, a file, a published page, Access's), which would hear
      // nothing.
      const app = windows.filter((client) => {
        const at = new URL(client.url);
        return at.origin === self.location.origin && !/^\/(api|u|cdn-cgi)\//.test(at.pathname);
      });
      const open = app.find((client) => client.focused) ?? app[0];
      if (!open) return self.clients.openWindow(url);
      open.postMessage({ type: "open", url });
      return open.focus();
    })(),
  );
});

// The browser replaced the subscription (it expired, or the push service rotated it) while the app may be closed: hand
// the Worker the new one, so pushes keep coming. The app's next load does the same, so a failure here loses nothing for
// long.
self.addEventListener("pushsubscriptionchange", (event) => {
  const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  event.waitUntil(
    (async () => {
      const old = event.oldSubscription;
      let next = event.newSubscription;
      if (!next) {
        const key = await fetch("/api/push/key").then((response) => (response.ok ? response.json() : null));
        if (!key || typeof key.publicKey !== "string") return;
        next = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key.publicKey });
      }
      await Promise.all([
        old && post("/api/push/unsubscribe", { endpoint: old.endpoint }).catch(() => {}),
        post("/api/push/subscribe", next.toJSON()),
      ]);
    })().catch(() => {}),
  );
});
