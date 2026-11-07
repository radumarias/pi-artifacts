/**
 * The user's sign-ins to MCP servers that sign in each user (`auth: "oauth"`), as the account menu lists them, and the
 * notices about them the sidebar shows. Tokens never leave the Worker: this is only names and times.
 */
export interface McpSignInView {
  server: string;
  signedIn: boolean;
  /** When they last signed in (the start of the grant); absent when signed out. */
  signedInAt?: number;
  /** When the grant is counted to end (signedInAt + MCP_GRANT_DAYS): the server may end it sooner. */
  endsAt?: number;
  /**
   * Signed in once, and that sign-in no longer works (a refused refresh): runs that may use the server wait for a new
   * sign-in. Disconnect lets them go on without it.
   */
  lapsed?: true;
  /** An agent's scheduled runs use this server: the app keeps it refreshed and warns before it ends. */
  usedByRuns: boolean;
  /** The same-origin link that starts a sign-in. */
  link: string;
  notice?: SignInNoticeKind;
  /** With the `needed` notice: what is waiting ("Daily brief"). */
  waiting?: string;
  /**
   * With the `needed` notice: an agent waiting reads the server in a step, so it cannot go on without it: Disconnect is
   * no way out for it, only changing the agent or turning it off.
   */
  stepReads?: true;
}

/** `needed`: a run, or the daily refresh, found the sign-in no longer works. `ending`: the grant ends in a few days. */
export type SignInNoticeKind = "needed" | "ending";

/** What the sidebar's socket sends when a sign-in needs the user: the app shows it, and the browser when it may. */
export interface SignInNotice {
  type: "sign-in";
  server: string;
  kind: SignInNoticeKind;
  link: string;
  /** What is waiting, in a few words ("Daily brief"); absent for the daily refresh. */
  what?: string;
  /** With `ending`: when the grant is counted to end. */
  endsAt?: number;
  /** An agent waiting reads the server in a step (McpSignInView.stepReads). */
  stepReads?: true;
  at: number;
}

/** What to do about an agent that reads these servers in a step, when its owner has no access to them any more. */
export function readsInStepText(agent: string, servers: readonly string[]): string {
  return `${agent} reads ${servers.join(", ")} in a step, so it cannot go on without it: change its steps or turn it off.`;
}

/** Whether a notice offers Disconnect: for a sign-in that lapsed, unless an agent waiting reads the server in a step. */
export function offersDisconnect(view: { lapsed?: boolean; stepReads?: boolean }): boolean {
  return Boolean(view.lapsed && !view.stepReads);
}

/**
 * One line for a notice: what the user reads in the sidebar and in the browser's notification. It offers Disconnect only
 * as `offersDisconnect` does; an agent that reads the server in a step is told to be changed or turned off instead.
 */
export function signInNoticeText(
  notice: Pick<SignInNotice, "server" | "kind" | "what" | "endsAt" | "stepReads"> & { lapsed?: boolean },
): { title: string; body: string } {
  if (notice.kind === "ending") {
    const when = notice.endsAt ? ` around ${new Date(notice.endsAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : " soon";
    return { title: `Sign in to ${notice.server} again`, body: `Your sign-in runs out${when}. Sign in again so scheduled runs keep working.` };
  }
  const way = notice.stepReads
    ? ` No access any more? ${readsInStepText(notice.what ?? "An agent", [notice.server])}`
    : offersDisconnect(notice)
      ? " No access any more? Disconnect it, and runs go on without it."
      : "";
  return {
    title: `Sign in to ${notice.server}`,
    body: notice.what
      ? `${notice.what} is waiting for you to sign in, then it runs.${way}`
      : `Your sign-in no longer works. Sign in again so scheduled runs keep working.${way}`,
  };
}
