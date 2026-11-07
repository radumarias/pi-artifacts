import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { GuardrailRule, PendingActionView } from "../shared/limits.ts";
import { blankDraft, draftOf, endedText, expiresText, newRuleId, ruleLine, ruleOf, ruleWarning, type RuleDraft } from "../src/agents/limits/rules.ts";
import { ActionCard, ActionDecision, ChatActions } from "../src/chat/ActionCard.tsx";

const HOUR = 3_600_000;

describe("rule lines", () => {
  it("say a rule in one line, as the list shows it", () => {
    const never: GuardrailRule = { id: "a1", server: "mail", tool: "send", arg: "to", kind: "never", value: ["*@example.com"], effect: "block" };
    const max: GuardrailRule = { id: "a2", server: "crm", tool: "update_deal", arg: "discount", kind: "max", value: 10, effect: "approve" };
    const quiet: GuardrailRule = { id: "a3", server: "*", tool: "*", kind: "quietDates", value: [{ from: "12-24", to: "12-26" }], effect: "block" };
    expect(ruleLine(never)).toBe("mail.send · to — Never *@example.com — Blocks it");
    expect(ruleLine(max)).toBe("crm.update_deal · discount — At most 10 — Needs approval");
    expect(ruleLine(quiet)).toBe("Quiet dates 24 Dec–26 Dec every year — Blocks it");
    expect(ruleLine({ id: "a4", server: "crm", tool: "*", kind: "callsPerDay", value: 20, effect: "warn", tz: "Europe/Bucharest" })).toBe(
      "crm (any change) — At most 20 calls a day (Europe/Bucharest) — Warns",
    );
    expect(ruleLine({ ...quiet, value: [{ from: "2027-01-02", to: "2027-01-04" }] })).toBe("Quiet dates 2 Jan 2027–4 Jan 2027 — Blocks it");
  });

  it("warn when the server no longer lists a rule's tool, or its tool the rule's argument", () => {
    const tools = [
      {
        name: "update_deal",
        description: "",
        inputSchema: { type: "object", properties: { discount_pct: { type: "number" } }, additionalProperties: false },
      },
    ];
    const rule = { server: "crm", tool: "update_deal", arg: "discount_pct" };
    expect(ruleWarning(rule, tools)).toBeNull();
    expect(ruleWarning(rule, null)).toBeNull();
    expect(ruleWarning({ ...rule, tool: "*" }, tools)).toBeNull();
    expect(ruleWarning({ ...rule, tool: "change_deal" }, tools)).toEqual({
      on: "tool",
      text: "crm lists no tool change_deal now, so this rule checks no call. If it was renamed, pick its new name.",
    });
    expect(ruleWarning({ ...rule, arg: "discount" }, tools)).toEqual({
      on: "arg",
      text: "update_deal has no argument discount now, so this rule fires on every call to it.",
    });
  });

  it("make new ids that checkRule takes, and none already in the list", () => {
    const taken = [{ id: "00000000" }];
    const id = newRuleId(taken);
    expect(id).toMatch(/^[a-f0-9]{8}$/);
    expect(id).not.toBe("00000000");
  });
});

describe("the rule editor's form", () => {
  const form = (change: Partial<RuleDraft>): RuleDraft => ({ ...blankDraft([]), ...change });

  it("checks what it makes with checkRule, saying what to fix", () => {
    expect(ruleOf(form({ server: "crm", tool: "update_deal", kind: "max", arg: "discount", number: "" }))).toEqual({
      error: "Its limit is a number.",
    });
    const made = ruleOf(form({ id: "abcd1234", server: "crm", tool: "update_deal", kind: "max", arg: "discount", number: "10", effect: "approve" }));
    expect(made).toEqual({
      rule: { id: "abcd1234", server: "crm", tool: "update_deal", arg: "discount", kind: "max", value: 10, effect: "approve" },
    });
  });

  it("reads never values one a line, as numbers for a number argument", () => {
    const draft = form({ server: "crm", tool: "update", kind: "never", arg: "stage", values: "lost\n 3 \n\n" });
    expect(ruleOf(draft)).toMatchObject({ rule: { value: ["lost", "3"] } });
    expect(ruleOf(draft, "number")).toMatchObject({ rule: { value: ["lost", 3] } });
  });

  it("takes only true or false for a yes-or-no argument", () => {
    const typed = form({ server: "crm", tool: "update", kind: "never", arg: "archived", values: "yes" });
    expect(ruleOf(typed, "boolean")).toEqual({ error: 'archived is yes or no: pick true or false, not "yes".' });
    expect(ruleOf({ ...typed, values: "true" }, "boolean")).toMatchObject({ rule: { value: ["true"] } });
  });

  it("refuses a current value read whose input is not JSON", () => {
    const draft = form({
      server: "crm",
      tool: "update",
      kind: "maxChange",
      arg: "amount",
      number: "5",
      currentTool: "get",
      currentInput: "{id:",
      currentPath: "amount",
    });
    expect(ruleOf(draft)).toMatchObject({ error: expect.stringMatching(/not JSON/) });
  });

  it("gives back the rule a saved one was", () => {
    const rules: GuardrailRule[] = [
      {
        id: "r1",
        server: "crm",
        tool: "update",
        arg: "amount",
        kind: "maxChange",
        value: 20,
        percent: true,
        current: { tool: "get", input: { id: "{{input.id}}" }, path: "data.amount" },
        effect: "approve",
        note: "big moves",
      },
      {
        id: "r2",
        server: "*",
        tool: "*",
        kind: "quietDates",
        value: [
          { from: "12-30", to: "01-02" },
          { from: "2027-04-01", to: "2027-04-02" },
        ],
        tz: "UTC",
        effect: "block",
      },
      { id: "r3", server: "mail", tool: "send", arg: "to", kind: "never", value: ["*@example.com", 7], effect: "warn" },
    ];
    for (const rule of rules) expect(ruleOf(draftOf(rule), rule.kind === "never" ? "number" : undefined)).toEqual({ rule });
  });
});

describe("waiting actions", () => {
  const action: PendingActionView = {
    id: "x1",
    chatId: "c1",
    kind: "approval",
    actor: { name: "pi" },
    server: "crm",
    tool: "update_deal",
    input: { id: "d1", discount: 15 },
    why: "discount of crm.update_deal is 15, over 10",
    createdAt: 0,
    expiresAt: 11 * HOUR,
    status: "pending",
  };

  it("say when they expire, and how they ended", () => {
    expect(expiresText(11 * HOUR, 0)).toBe("expires in 11 h");
    expect(expiresText(20 * 60_000, 0)).toBe("expires in 20 min");
    expect(expiresText(0, 1)).toBe("expired");
    expect(endedText(action, 0)).toBeNull();
    expect(endedText(action, 12 * HOUR)).toBe("Expired");
    expect(endedText({ ...action, status: "done", result: "updated" }, 0)).toBe("Ran · updated");
    expect(endedText({ ...action, status: "failed", result: "not found" }, 0)).toBe("Failed · not found");
    expect(endedText({ ...action, status: "declined" }, 0)).toBe("Declined");
    expect(endedText({ ...action, kind: "proposal", status: "declined" }, 0)).toBe("Dismissed");
  });

  it("show their buttons to the chat's owner only, from the chat's live state", () => {
    const card = (isOwner: boolean, live?: PendingActionView) =>
      renderToStaticMarkup(
        <ChatActions.Provider value={{ actions: new Map(live ? [[live.id, live]] : []), isOwner, ownerName: "ada" }}>
          <ActionCard action={{ ...action, expiresAt: Date.now() + 11 * HOUR }} />
        </ChatActions.Provider>,
      );
    expect(card(true)).toContain(">Approve<");
    expect(card(true)).toContain("asks to");
    expect(card(false)).not.toContain(">Approve<");
    expect(card(false)).toContain("Waits for ada to approve it.");
    expect(card(true, { ...action, status: "done", result: "updated" })).toContain("Ran · updated");
  });

  it("are decided in the feed while they wait, and show nothing there once they wait no more", () => {
    const later = { ...action, expiresAt: Date.now() + 11 * HOUR };
    const waiting = renderToStaticMarkup(<ActionDecision action={later} waiting />);
    expect(waiting).toContain(">Approve<");
    expect(waiting).toContain(">Decline<");
    expect(waiting).toContain("expires in 11 h");
    expect(renderToStaticMarkup(<ActionDecision action={{ ...later, kind: "proposal" }} waiting />)).toContain(">Run<");
    // Decided from its card in the chat, or expired: the feed item is resolved, and has no buttons.
    expect(renderToStaticMarkup(<ActionDecision action={later} waiting={false} />)).toBe("");
    // Still waiting in the feed, but past its time (the chat did not say yet): no buttons either.
    expect(renderToStaticMarkup(<ActionDecision action={{ ...later, expiresAt: Date.now() - HOUR }} waiting />)).toContain("Expired");
  });

  it("say how they ended on a resolved feed item, as it kept it, after the feed reloads", () => {
    const failed = renderToStaticMarkup(<ActionDecision action={{ ...action, status: "failed", result: "deal 5 is closed" }} waiting={false} />);
    expect(failed).toContain("Failed · deal 5 is closed");
    expect(failed).not.toContain(">Approve<");
    expect(renderToStaticMarkup(<ActionDecision action={{ ...action, status: "done" }} waiting={false} />)).toContain("Ran");
    expect(renderToStaticMarkup(<ActionDecision action={{ ...action, status: "declined" }} waiting={false} />)).toContain("Declined");
    expect(renderToStaticMarkup(<ActionDecision action={{ ...action, status: "expired" }} waiting={false} />)).toContain("Expired");
  });
});
