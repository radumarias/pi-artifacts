import puppeteer, { type Browser, type BrowserWorker, type Page } from "@cloudflare/puppeteer";
import { errorMessage } from "../../shared/util.ts";
import { SCRIPT_HOSTS } from "./serve.ts";

/** The only hosts the check's browser may reach: the page's script hosts and Google Fonts. Everything else it renders itself. */
const ALLOWED_DOMAINS = [...SCRIPT_HOSTS.map((url) => new URL(url).hostname), "fonts.googleapis.com", "fonts.gstatic.com"];

/**
 * How long the browser stays open after a check, for the next one: checks come seconds apart while the agent fixes a
 * page. Browser time is billed, so not much longer.
 */
const IDLE_MS = 15_000;

/** Why there is no browser to check with: the check is skipped, and the page stays a draft (published unchecked only in local development). */
export class BrowserUnavailable extends Error {}

/**
 * One headless browser (Cloudflare Browser Rendering) for a chat's page checks, opened on the first check and closed
 * after IDLE_MS without one. Each check gets a fresh page.
 */
export class CheckBrowser {
  #browser: Promise<Browser> | undefined;
  #idle: ReturnType<typeof setTimeout> | undefined;
  #using = 0;

  readonly #binding: BrowserWorker | undefined;

  constructor(binding: BrowserWorker | undefined) {
    this.#binding = binding;
  }

  async withPage<T>(use: (page: Page) => Promise<T>): Promise<T> {
    this.#using++;
    clearTimeout(this.#idle);
    try {
      const page = await this.#page();
      try {
        return await use(page);
      } finally {
        await page.close().catch(() => {});
      }
    } finally {
      if (--this.#using === 0) this.#idle = setTimeout(() => this.close(), IDLE_MS);
    }
  }

  close(): void {
    const browser = this.#browser;
    this.#browser = undefined;
    void browser?.then((b) => b.close()).catch(() => {});
  }

  async #page(): Promise<Page> {
    const binding = this.#binding;
    if (!binding) throw new BrowserUnavailable("this deployment has no browser binding");
    try {
      return await (await this.#open(binding)).newPage();
    } catch (error) {
      // The next check starts a new browser. Close this one, if it started, unless another check still uses it.
      const failed = this.#browser;
      this.#browser = undefined;
      if (this.#using === 1) void failed?.then((b) => b.close()).catch(() => {});
      // Only the first line: a launch failure can carry a whole log.
      const why = errorMessage(error).split("\n")[0].slice(0, 300);
      throw new BrowserUnavailable(`the browser did not start (${why})`);
    }
  }

  /** The open browser, or a new one when it has gone (its session ended). Chained, so checks at once share one launch. */
  #open(binding: BrowserWorker): Promise<Browser> {
    const previous = this.#browser;
    this.#browser = (async () => {
      const open = await previous?.catch(() => undefined);
      if (open?.connected) return open;
      return puppeteer.launch(binding, { keep_alive: IDLE_MS + 15_000, guardrails: { allowedDomains: ALLOWED_DOMAINS } });
    })();
    return this.#browser;
  }
}
