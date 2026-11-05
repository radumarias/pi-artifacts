/**
 * Where the sidebar's "Back" link goes: the website the app was opened from, by the browser's referrer. A site can name
 * the exact page as `?from=<url>` in its link; the sign-in redirect on a first visit replaces the referrer, so `from`
 * is also what gives Back on that visit.
 */
export interface BackLink {
  url: string;
  /** What the link shows: the site's hostname, so where it goes is always visible. */
  host: string;
}

/** The query parameter a site's link to the app names its page in. The app takes it off every address it opens on. */
export const FROM_PARAM = "from";

/**
 * Sign-in pages: the referrer after a sign-in (Cloudflare Access and the identity providers it sends people to),
 * never the website the user came from. Matched with their subdomains.
 */
export const SIGN_IN_HOSTS = [
  "cloudflareaccess.com",
  "amazoncognito.com",
  "accounts.google.com",
  "github.com",
  "login.microsoftonline.com",
  "okta.com",
  "auth0.com",
];

/**
 * The page to go back to, or undefined when there is none: the referrer, when it is a web page on another site that is
 * not a sign-in page, and the `from` page instead when it is on the referrer's origin, or when the sign-in replaced the
 * referrer. So a link posted elsewhere cannot point Back at a third site: Back goes where the user came from.
 */
export function backLink(
  from: string | null | undefined,
  referrer: string | null | undefined,
  ownOrigin: string,
  signInHosts: readonly string[] = SIGN_IN_HOSTS,
): BackLink | undefined {
  const page = webPage(from, ownOrigin, signInHosts);
  const came = webPage(referrer, ownOrigin, signInHosts);
  const url = page && (!came || page.origin === came.origin) ? page : came;
  return url && { url: url.href, host: url.hostname };
}

/** `value` as a web page on another site than the app's, and not a sign-in page. */
function webPage(value: string | null | undefined, ownOrigin: string, signInHosts: readonly string[]): URL | undefined {
  const url = parseUrl(value);
  if (!url || !isWebOrigin(url) || url.origin === ownOrigin) return undefined;
  return signInHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`)) ? undefined : url;
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
