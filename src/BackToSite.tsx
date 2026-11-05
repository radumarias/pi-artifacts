import { backUrl, FROM_PARAM, type HomeSite } from "../shared/home-site.ts";
import { Icon } from "./Icon.tsx";

const STORE_KEY = "pi:from";

/** The page the site's link named, read once when the app loads (see rememberFromPage). */
let fromPage: string | null = null;

/**
 * Keep the page the site's link named (`?from=`) for this tab, and take it out of the address bar. Run before the app
 * reads its location. Kept per tab, so moving between chats, or a sign-in on the way in, does not lose it.
 */
export function rememberFromPage(): void {
  const url = new URL(location.href);
  const from = url.searchParams.get(FROM_PARAM);
  try {
    if (from === null) fromPage = sessionStorage.getItem(STORE_KEY);
    else sessionStorage.setItem(STORE_KEY, from);
  } catch {
    // Storage off (a private window, blocked site data): only this page load knows it.
  }
  if (from === null) return;
  fromPage = from;
  url.searchParams.delete(FROM_PARAM);
  history.replaceState(history.state, "", url);
}

/** A link back to the website the app was opened from, in this tab. `compact`: the arrow alone, for the sidebar rail. */
export function BackToSite({ site, compact = false }: { site: HomeSite; compact?: boolean }) {
  const label = `Back to ${site.name}`;
  return (
    <a
      className={compact ? "back-to-site compact" : "back-to-site"}
      href={backUrl(site, fromPage)}
      title={label}
      aria-label={compact ? label : undefined}
    >
      <Icon size={16} box={16}>
        <path d="M10 3L5 8l5 5" />
      </Icon>
      {!compact && <span>{label}</span>}
    </a>
  );
}
