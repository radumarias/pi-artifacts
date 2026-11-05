/**
 * The website people come to the app from, when a deployment has one (HOME_SITE_URL and HOME_SITE_NAME in
 * cloudflare.config.ts): the app shows a link back to it. The site links to the app, optionally naming the page to
 * come back to as `?from=<url>`.
 */
export interface HomeSite {
  name: string;
  url: string;
}

/** The query parameter a site's link to the app names its page in. */
export const FROM_PARAM = "from";

/** The configured site, or undefined unless both are set and the URL is https (http only for localhost). */
export function homeSite(url: string | undefined, name: string | undefined): HomeSite | undefined {
  const parsed = parseUrl(url);
  const label = name?.trim();
  if (!parsed || !label || !isWebOrigin(parsed)) return undefined;
  return { name: label, url: parsed.href };
}

/**
 * Where "Back" goes: the page the site named in `from`, when it is on the site's own origin, else the site's URL.
 * Only the site's origin, so a link from elsewhere cannot make the app's back link point to another site.
 */
export function backUrl(site: HomeSite, from: string | null | undefined): string {
  const page = parseUrl(from ?? undefined);
  return page && page.origin === new URL(site.url).origin ? page.href : site.url;
}

function parseUrl(value: string | undefined): URL | undefined {
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
