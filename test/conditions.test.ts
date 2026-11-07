import { describe, expect, it } from "vitest";
import { ConditionError, conditionNames, conditionProblem, evaluate, holds, parseCondition } from "../shared/conditions.ts";

const scope = {
  signups: { weekly: 940, lastYear: 1000, regions: [{ name: "West", signups: 120 }, { name: "North", signups: "300" }] },
  lastYear: 1000,
  alerts: [],
  quiet: false,
  name: "West",
  price: "1,234.50",
};

describe("conditions", () => {
  it("compares numbers, numeric text and text", () => {
    expect(holds("signups.weekly < 1000", scope)).toBe(true);
    expect(holds("signups.regions[1].signups >= 300", scope)).toBe(true);
    expect(holds("price > 1000", scope)).toBe(true);
    expect(holds('name == "West"', scope)).toBe(true);
    expect(holds("name = 'West'", scope)).toBe(true);
    expect(holds('name != "East"', scope)).toBe(true);
    expect(holds('"apple" < "banana"', scope)).toBe(true);
    expect(holds("1 == '1'", scope)).toBe(true);
  });

  it("reads a change with vs and percent literals", () => {
    expect(evaluate("signups.weekly vs lastYear", scope)).toBeCloseTo(-0.06);
    expect(holds("signups.weekly vs lastYear < -5%", scope)).toBe(true);
    expect(holds("signups.weekly vs signups.lastYear < -10%", scope)).toBe(false);
    expect(evaluate("change(110, 100)", scope)).toBeCloseTo(0.1);
    expect(evaluate("12.5%", scope)).toBe(0.125);
  });

  it("has logic, arithmetic and precedence", () => {
    expect(holds("len(alerts) > 0 or not quiet", scope)).toBe(true);
    expect(holds("len(alerts) > 0 and not quiet", scope)).toBe(false);
    expect(evaluate("1 + 2 * 3", scope)).toBe(7);
    expect(evaluate("(1 + 2) * 3", scope)).toBe(9);
    expect(evaluate("-2 - -3", scope)).toBe(1);
    expect(evaluate('"a" + 1', scope)).toBe("a1");
    expect(holds("not not true", scope)).toBe(true);
  });

  it("has a few functions over lists", () => {
    expect(evaluate('sum(signups.regions, "signups")', scope)).toBe(420);
    expect(evaluate('avg(signups.regions, "signups")', scope)).toBe(210);
    expect(evaluate("max(1, 5, 3)", scope)).toBe(5);
    expect(evaluate("count(signups.regions)", scope)).toBe(2);
    expect(evaluate("first(signups.regions).name", scope)).toBe("West");
    expect(evaluate("last(signups.regions).name", scope)).toBe("North");
    expect(evaluate("signups.regions[-1].name", scope)).toBe("North");
    expect(evaluate("round(2.345, 2)", scope)).toBe(2.35);
    expect(holds('contains(name, "es")', scope)).toBe(true);
    expect(holds("exists(nothing)", scope)).toBe(false);
  });

  it("treats a missing step as null, and says so when it needs a number", () => {
    expect(evaluate("nothing.at.all", scope)).toBe(null);
    expect(() => holds("nothing.weekly > 3", scope)).toThrow("nothing.weekly is missing.");
    expect(() => holds("name > 3", scope)).toThrow(/name is not a number/);
    expect(() => evaluate("1 / 0", scope)).toThrow(ConditionError);
    expect(() => evaluate("1 vs 0", scope)).toThrow(ConditionError);
  });

  it("never runs code: only its own grammar parses", () => {
    for (const bad of ["constructor.constructor('x')()", "a; b", "a => b", "`x`", "a ? b : c", "alert(1)", "import('x')"]) {
      expect(conditionProblem(bad), bad).not.toBeNull();
    }
    // A key named like a prototype's is only a missing key.
    expect(evaluate("signups.constructor", scope)).toBe(null);
    expect(evaluate('signups["__proto__"]', scope)).toBe(null);
    // Nor is a function, or a key contains() looks for.
    for (const bad of ["constructor(1)", "__proto__(1)", "tostring(1)"]) expect(conditionProblem(bad), bad).not.toBeNull();
    expect(evaluate('contains(signups, "toString")', scope)).toBe(false);
    expect(evaluate('contains(signups, "weekly")', scope)).toBe(true);
  });

  it("reports what is wrong, with where", () => {
    expect(conditionProblem("a >")).toBe("The condition ends too soon.");
    expect(conditionProblem("(a > 1")).toMatch(/Expected "\)"/);
    expect(conditionProblem('"open')).toMatch(/no closing quote/);
    expect(conditionProblem("nope(1)")).toMatch(/no function "nope"/);
    expect(conditionProblem("")).toBe("A condition is empty.");
    expect(conditionProblem("x".repeat(501))).toMatch(/at most 500/);
    expect(conditionProblem("a < b < c")).toMatch(/Unexpected "<"/);
    expect(() => parseCondition("(".repeat(60) + "1" + ")".repeat(60))).toThrow(/too deep/);
  });

  it("reads a path's keys as written: digits as indexes, names in their own case", () => {
    const nested = { a: [[1, 2], [3, 4, 5]], b: { True: "yes", true: "no", Null: 7 } };
    expect(evaluate("a.1.2", nested)).toBe(5);
    expect(evaluate("a.0.1 + a.1.0", nested)).toBe(5);
    expect(evaluate("b.True", nested)).toBe("yes");
    expect(evaluate("b.Null", nested)).toBe(7);
    expect(evaluate("1.5 + 1", nested)).toBe(2.5);
  });

  it("names what a condition reads", () => {
    expect(conditionNames("signups.weekly vs lastYear < -5% and len(alerts) > 0").sort()).toEqual(["alerts", "lastYear", "signups"]);
  });
});
