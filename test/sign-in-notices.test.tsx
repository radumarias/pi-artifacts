import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { McpSignInView } from "../shared/sign-ins.ts";
import { SignInNotices } from "../src/SignIns.tsx";

const needed: McpSignInView = {
  server: "Portal",
  signedIn: false,
  usedByRuns: true,
  link: "/api/mcp/sign-in/Portal",
  notice: "needed",
  waiting: "@brief",
};

describe("the sidebar's sign-in notice", () => {
  it("offers Disconnect for a lapsed sign-in, the way out for runs that would wait for it for good", () => {
    const lapsed = renderToStaticMarkup(<SignInNotices list={[{ ...needed, lapsed: true }]} onChange={() => {}} />);
    expect(lapsed).toContain(">Sign in</a>");
    expect(lapsed).toContain(">Disconnect</button>");
    expect(lapsed).toContain("Disconnect it, and runs go on without it.");
    // Never signed in: nothing to disconnect, and the text offers none.
    const never = renderToStaticMarkup(<SignInNotices list={[needed]} onChange={() => {}} />);
    expect(never).not.toContain(">Disconnect</button>");
    expect(never).not.toContain("Disconnect it");
    // Lapsed, but an agent waiting reads it in a step: Disconnect would not let it go on.
    const step = renderToStaticMarkup(<SignInNotices list={[{ ...needed, lapsed: true, stepReads: true }]} onChange={() => {}} />);
    expect(step).not.toContain(">Disconnect</button>");
    expect(step).toContain("@brief reads Portal in a step: change its steps or turn it off.");
  });
});
