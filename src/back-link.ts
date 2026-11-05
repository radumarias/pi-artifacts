/**
 * Where the sidebar's "Back" link goes: the website the app was opened from. It is the page the site's link named as
 * `?from=<url>`, else the page the browser came from (its referrer). The sign-in redirect on a first visit replaces
 * the referrer, so a site that wants Back on that visit too names its page in `from`.
 */
export interface BackLink {
  url: string;
  /** What the link shows: the site's hostname, so where it goes is always visible. */
  host: string;
}

/** The query parameter a site's link to the app names its page in. The app takes it off every address it opens on. */
export const FROM_PARAM = "from";

/**
 * The page to go back to, from the `from` parameter or else the referrer, or undefined when neither is a web page on
 * another site. The app's own pages and its sign-in pages (`signInHosts`, matched with their subdomains) are not a
 * website the user came from.
 */
export function backLink(from: string | null | undefined, referrer: string | null | undefined, ownOrigin: string, signInHosts: string[]): BackLink | undefined {
  for (const candidate of [from, referrer]) {
    const url = parseUrl(candidate);
    if (!url || !isWebOrigin(url) || url.origin === ownOrigin) continue;
    if (signInHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) continue;
    return { url: url.href, host: url.hostname };
  }
  return undefined;
}

function parseUrl(value: string | null | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    return new URL(value.trim());
  } catch {
    return undefined;
  }
}

function isWebOrigin(url: URL): boolean {
  return url.protocol === "https:" || (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"));
}
