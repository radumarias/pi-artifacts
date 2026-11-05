import { backLink, FROM_PARAM, type BackLink } from "../shared/home-site.ts";
import { Icon } from "./Icon.tsx";

const STORE_KEY = "pi:back";

/** Cloudflare Access's sign-in pages: the referrer after a sign-in, never the site the user came from. */
const SIGN_IN_HOSTS = ["cloudflareaccess.com"];

/**
 * Work out where Back goes, once, before the app reads its location: from `?from=` (then taken out of the address bar)
 * or the referrer, else what this tab kept from an earlier load, so moving between chats or reloading keeps it.
 */
function rememberBackLink(): BackLink | undefined {
  const url = new URL(location.href);
  const from = url.searchParams.get(FROM_PARAM);
  if (from !== null) {
    url.searchParams.delete(FROM_PARAM);
    history.replaceState(history.state, "", url);
  }
  const found = backLink(from, document.referrer, location.origin, SIGN_IN_HOSTS);
  try {
    if (found) sessionStorage.setItem(STORE_KEY, found.url);
    else return backLink(sessionStorage.getItem(STORE_KEY), null, location.origin, SIGN_IN_HOSTS);
  } catch {
    // Storage off (a private window, blocked site data): only this page load knows it.
  }
  return found;
}

/** Where Back goes for this tab, or undefined when the app was not opened from another website. */
export const back = rememberBackLink();

/** A link back to the website the app was opened from, in this tab. `compact`: the arrow alone, for the sidebar rail. */
export function BackToSite({ link, compact = false }: { link: BackLink; compact?: boolean }) {
  const label = `Back to ${link.host}`;
  return (
    <a className={compact ? "back-to-site compact" : "back-to-site"} href={link.url} title={label} aria-label={compact ? label : undefined}>
      <Icon size={16} box={16}>
        <path d="M10 3L5 8l5 5" />
      </Icon>
      {!compact && <span>{label}</span>}
    </a>
  );
}
