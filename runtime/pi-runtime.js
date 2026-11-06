// The artifact page runtime, inlined at the top of every published page.
//
// It gives the page `window.pi.use(name)`, the same shape as Claude's
// `window.claude.use(name)`. The page has no network (connect-src 'none'):
// every call goes over a MessagePort to the viewer page that frames it, which
// forwards it to the Worker and on to the chat's Durable Object. The contract
// is documented in runtime/runtime.d.ts.
(() => {
  "use strict";
  if (window.pi) return;

  const CONNECT_TIMEOUT_MS = 10_000;

  // The page says hello; the viewer page that frames it answers with one port, once.
  const session = new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    addEventListener("message", (event) => {
      if (event.source !== window.parent) return;
      const data = event.data;
      if (!data || data.type !== "pi:connect" || !event.ports || !event.ports[0]) return;
      finish({ port: event.ports[0], manifest: data.manifest || {} });
    });
    setTimeout(() => finish(null), CONNECT_TIMEOUT_MS);
    if (window.parent !== window) window.parent.postMessage({ type: "pi:hello" }, "*");
  });

  // One link per page: the port, with the calls waiting on it and the watches it feeds.
  let link;
  function connected() {
    if (!link) link = session.then((s) => (s ? createLink(s.port, s.manifest) : null));
    return link;
  }

  const namespaces = new Map();
  function use(name) {
    const make = { mcp: createMcp, storage: createStorage, ai: createAi }[name];
    if (typeof make !== "function") return Promise.resolve(null);
    if (!namespaces.has(name)) namespaces.set(name, connected().then((l) => (l ? make(l) : null)));
    return namespaces.get(name);
  }

  function piError(error) {
    const e = new Error(error.message || error.code);
    for (const key of ["code", "server", "retryable", "retryAfterMs", "result"]) {
      if (error[key] !== undefined) e[key] = error[key];
    }
    return e;
  }

  function badRequest(message) {
    return piError({ code: "bad_request", message });
  }

  function checkJson(input) {
    try {
      JSON.stringify(input);
      return true;
    } catch {
      return false;
    }
  }

  function createLink(port, manifest) {
    let seq = 0;
    const pending = new Map();
    const watchers = new Map();
    port.onmessage = (event) => {
      const message = event.data;
      if (!message) return;
      if (message.type === "reply") {
        const call = pending.get(message.id);
        if (!call) return;
        pending.delete(message.id);
        if (message.ok) call.resolve(message.value);
        else call.reject(piError(message.error));
      } else if (message.type === "watch") {
        const handler = watchers.get(message.watchId);
        if (!handler) return;
        const ev = message.event;
        try {
          handler(ev.type === "error" ? { type: "error", error: piError(ev.error) } : ev);
        } catch (err) {
          console.error(err);
        }
      }
    };
    return {
      port,
      manifest,
      watchers,
      nextId: () => ++seq,
      request(method, params) {
        const id = ++seq;
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          port.postMessage({ type: "request", id, method, params });
        });
      },
    };
  }

  /** A call that rejects with `cancelled` once `signal` fires; the reply, if any, is then dropped. */
  function abortable(call, signal) {
    if (!signal) return call;
    if (signal.aborted) return Promise.reject(piError({ code: "cancelled", message: "aborted" }));
    return new Promise((resolve, reject) => {
      const abort = () => reject(piError({ code: "cancelled", message: "aborted" }));
      signal.addEventListener("abort", abort, { once: true });
      call.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  function createMcp(link) {
    const { port, watchers, request } = link;
    const servers = (link.manifest.mcp && link.manifest.mcp.servers) || [];

    function callTool(server, tool, input, options) {
      options = options || {};
      if (typeof server !== "string" || typeof tool !== "string") return Promise.reject(badRequest("server and tool must be strings"));
      if (!checkJson(input)) return Promise.reject(badRequest("input must be plain JSON"));
      return abortable(request("call", { server, tool, input: input === undefined ? {} : input, cache: options.cache }), options.signal);
    }

    function watchTool(server, tool, input, handler, options) {
      if (typeof handler !== "function") throw new TypeError("watchTool needs a handler function");
      options = options || {};
      const watchId = link.nextId();
      watchers.set(watchId, handler);
      if (typeof server !== "string" || typeof tool !== "string" || !checkJson(input)) {
        queueMicrotask(() => {
          if (watchers.has(watchId)) handler({ type: "error", error: badRequest("server and tool must be strings and input plain JSON") });
        });
        return () => watchers.delete(watchId);
      }
      port.postMessage({
        type: "watch",
        watchId,
        server,
        tool,
        input: input == null ? {} : input,
        refetchInterval: options.refetchInterval,
        staleTime: options.cache && options.cache.staleTime,
      });
      return () => {
        if (watchers.delete(watchId)) port.postMessage({ type: "unwatch", watchId });
      };
    }

    function invalidate(server, tool, input) {
      if (input !== undefined && (server === undefined || tool === undefined)) {
        return Promise.reject(badRequest("input needs server and tool"));
      }
      return request("invalidate", { server, tool, input });
    }

    function listTools(server) {
      const list = servers
        .filter((s) => server === undefined || s.server === server)
        .map((s) => ({ server: s.server, kind: "connector", authStatus: "connected", tools: s.tools.map((name) => ({ name, description: "" })) }));
      return Promise.resolve({ servers: list });
    }

    function describeTool(server, tool) {
      return request("describe", { server, tool });
    }

    function handle(name) {
      const entry = servers.find((s) => s.server === name);
      if (!entry) return null;
      const methods = {};
      for (const tool of entry.tools) {
        methods[tool] = (input, options) => callTool(name, tool, input, options).then((r) => (r.payload !== undefined ? r.payload : r));
      }
      return Object.freeze(methods);
    }

    function server(name) {
      const h = handle(name);
      return h ? Promise.resolve(h) : Promise.reject(piError({ code: "server_not_connected", server: name, message: `${name} is not declared by this page` }));
    }

    const namespace = { callTool, watchTool, invalidate, listTools, describeTool, server };
    // mcp.CoinGecko.execute(input): one property per declared server.
    for (const s of servers) {
      if (!(s.server in namespace)) namespace[s.server] = handle(s.server);
    }
    return Object.freeze(namespace);
  }

  // What a page saves (pi.use("storage")): the viewer's own values for this page over the author's, loaded once and
  // read synchronously; changes go back in the background, a short while after the last one. The localStorage
  // stand-in below is the same store. The Worker puts its limits in when it serves the page (worker/artifacts/serve.ts).
  const LIMITS = __PAGE_STORAGE_LIMITS__;
  const WRITE_DELAY_MS = 500;
  const saved = { values: new Map(), changes: new Map(), isAuthor: false, link: null, timer: 0 };

  function quotaError(message) {
    return new DOMException(message, "QuotaExceededError");
  }

  function change(key, value) {
    saved.changes.set(key, value);
    if (!saved.link) return;
    clearTimeout(saved.timer);
    saved.timer = setTimeout(flush, WRITE_DELAY_MS);
  }

  /** Send the changes made so far. Resolves once they are saved; rejects with why they were not. */
  function flush() {
    clearTimeout(saved.timer);
    if (!saved.link || saved.changes.size === 0) return Promise.resolve();
    const changes = Object.fromEntries(saved.changes);
    saved.changes.clear();
    const write = saved.link.request("storage", { op: "write", changes }).then(() => undefined);
    write.catch((error) => console.error("pi storage: not saved:", error.message));
    return write;
  }

  const store = Object.freeze({
    get length() {
      return saved.values.size;
    },
    get isAuthor() {
      return saved.isAuthor;
    },
    key(index) {
      const key = [...saved.values.keys()][index];
      return key === undefined ? null : key;
    },
    keys() {
      return [...saved.values.keys()];
    },
    getItem(key) {
      const value = saved.values.get(String(key));
      return value === undefined ? null : value;
    },
    setItem(key, value) {
      key = String(key);
      value = String(value);
      if (key.length > LIMITS.keyChars) throw quotaError(`A key is at most ${LIMITS.keyChars} characters.`);
      if (value.length > LIMITS.valueChars) throw quotaError(`A value is at most ${LIMITS.valueChars} characters.`);
      if (saved.values.get(key) === value) return;
      saved.values.set(key, value);
      change(key, value);
    },
    removeItem(key) {
      key = String(key);
      if (!saved.values.delete(key)) return;
      change(key, null);
    },
    clear() {
      for (const key of [...saved.values.keys()]) store.removeItem(key);
    },
    flush,
    /** Drop this viewer's own values: back to the author's (for the author: no defaults for anyone). */
    reset() {
      clearTimeout(saved.timer);
      saved.changes.clear();
      if (!saved.link) {
        saved.values = new Map();
        return Promise.resolve();
      }
      return saved.link.request("storage", { op: "reset" }).then((loaded) => {
        saved.values = new Map(Object.entries(loaded.values || {}));
      });
    },
  });

  function createStorage(link) {
    return link.request("storage", { op: "load" }).then(
      (loaded) => {
        const values = new Map(Object.entries(loaded.values || {}));
        // What the page changed while the values loaded wins over them, and is saved now.
        for (const [key, value] of saved.changes) {
          if (value === null) values.delete(key);
          else values.set(key, value);
        }
        saved.values = values;
        saved.isAuthor = loaded.isAuthor === true;
        saved.link = link;
        if (saved.changes.size) saved.timer = setTimeout(flush, WRITE_DELAY_MS);
        addEventListener("pagehide", () => void flush());
        addEventListener("visibilitychange", () => document.visibilityState === "hidden" && void flush());
        return store;
      },
      (error) => {
        // The page still runs on what it sets now; nothing is saved, so a later load cannot be overwritten with it.
        console.warn("pi storage: saved values could not be loaded:", error.message);
        return store;
      },
    );
  }

  // An opaque origin has no localStorage (reading it throws): in its place, the page's saved values, so code written
  // for localStorage keeps its state. The first read starts loading them; await pi.use("storage") before relying on it.
  // sessionStorage lives only as long as the page.
  function memoryStorage() {
    const values = new Map();
    return Object.freeze({
      get length() {
        return values.size;
      },
      key: (index) => [...values.keys()][index] ?? null,
      getItem: (key) => (values.has(String(key)) ? values.get(String(key)) : null),
      setItem: (key, value) => void values.set(String(key), String(value)),
      removeItem: (key) => void values.delete(String(key)),
      clear: () => values.clear(),
    });
  }
  function standIn(name, value, onRead) {
    try {
      if (window[name]) return;
    } catch {}
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: true,
        get() {
          if (onRead) onRead();
          return value;
        },
      });
    } catch {}
  }
  standIn("localStorage", store, () => void use("storage"));
  standIn("sessionStorage", memoryStorage());

  // pi.use("ai"): one answer from a small model, paid for by the viewer, for what they typed into the page.
  function createAi(link) {
    return Object.freeze({
      complete(request, options) {
        options = options || {};
        const body = typeof request === "string" ? { messages: [{ role: "user", content: request }] } : request;
        if (!body || !Array.isArray(body.messages) || !checkJson(body)) {
          return Promise.reject(badRequest("complete takes a prompt or { system?, messages, maxTokens?, json? }"));
        }
        return abortable(link.request("ai", body), options.signal);
      },
    });
  }

  Object.defineProperty(window, "pi", { value: Object.freeze({ use }), enumerable: true });
})();
