import puppeteer, { type Browser, type BrowserWorker, type Page } from "@cloudflare/puppeteer";
import { deadline, errorMessage } from "../../shared/util.ts";
import { SCRIPT_HOSTS } from "./serve.ts";

/** The only hosts the check's browser may reach: the page's script hosts and Google Fonts. Everything else it renders itself. */
const ALLOWED_DOMAINS = [...SCRIPT_HOSTS.map((url) => new URL(url).hostname), "fonts.googleapis.com", "fonts.gstatic.com"];

/**
 * How long the browser stays open after a check, for the next one: checks come seconds apart while the agent fixes a
 * page. Browser time is billed, so not much longer.
 */
const IDLE_MS = 15_000;

/** How long a browser may take to start (Browser Rendering can queue a launch) before the check gives up on it. */
const LAUNCH_MS = 30_000;
/** How long opening a page in a running browser may take. */
const PAGE_MS = 10_000;
/** How long closing a page may take before the check stops waiting on it. */
const CLOSE_MS = 5_000;

/** Why there is no browser to check with: the check is skipped, and the page stays a draft (published unchecked only in local development). */
export class BrowserUnavailable extends Error {}

/** The check ran out of time: the page held the browser (a loop that never ends, a wait on something forever). */
export class CheckTimedOut extends Error {}

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

  /**
   * Run `use` with a fresh page, for at most `timeoutMs` (CheckTimedOut after), and until `signal` aborts. A page that
   * ran out of time may hold the browser (a script that never yields blocks every devtools call), so the browser goes
   * with it, and the next check starts another. Stopping keeps the browser for the next check.
   */
  async withPage<T>(use: (page: Page) => Promise<T>, { timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal }): Promise<T> {
    this.#using++;
    clearTimeout(this.#idle);
    try {
      const opening = this.#page();
      // Stopped while the browser starts: the page it gets later closes unused, and the launch stays for the next check.
      const page = await deadline(opening, LAUNCH_MS + PAGE_MS, () => new BrowserUnavailable("the browser did not start in time"), signal).catch(
        (error: unknown) => {
          void opening.then((late) => late.close()).catch(() => {});
          throw error;
        },
      );
      try {
        return await deadline(use(page), timeoutMs, () => new CheckTimedOut(`the check did not finish in ${timeoutMs / 1000} s`), signal);
      } catch (error) {
        // A page that ran out of time may hold the browser and never answer a close: the browser goes too.
        if (error instanceof CheckTimedOut) this.#drop();
        throw error;
      } finally {
        // Not waited on: nothing after it needs the page gone.
        void deadline(page.close(), CLOSE_MS, () => new Error("closing the page took too long")).catch(() => {});
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

  /** Forget the browser, so the next check starts another, and close it unless another check still uses it. */
  #drop(): void {
    if (this.#using === 1) this.close();
    else this.#browser = undefined;
  }

  async #page(): Promise<Page> {
    const binding = this.#binding;
    if (!binding) throw new BrowserUnavailable("this deployment has no browser binding");
    try {
      const browser = await this.#open(binding);
      return await deadline(browser.newPage(), PAGE_MS, () => new Error(`no new page within ${PAGE_MS / 1000} s`));
    } catch (error) {
      // The next check starts a new browser.
      this.#drop();
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
      const launch = puppeteer.launch(binding, { keep_alive: IDLE_MS + 15_000, guardrails: { allowedDomains: ALLOWED_DOMAINS } });
      // A launch that comes back after its deadline closes again, unused.
      return deadline(launch, LAUNCH_MS, () => {
        void launch.then((late) => late.close()).catch(() => {});
        return new Error(`no browser within ${LAUNCH_MS / 1000} s`);
      });
    })();
    return this.#browser;
  }
}
