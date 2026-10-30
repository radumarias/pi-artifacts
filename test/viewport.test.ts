import { describe, expect, it } from "vitest";
import { isViewportId, layoutViewport } from "../src/artifact/viewport.tsx";

const big = { width: 2000, height: 1400 };

describe("preview viewport", () => {
  it("fills the pane in fit mode", () => {
    expect(layoutViewport("fit", false, big)).toBeNull();
  });

  it("keeps a device at its own size when it fits", () => {
    expect(layoutViewport("mobile", false, big)).toEqual({ width: 390, height: 844, scale: 1 });
    expect(layoutViewport("tablet", true, big)).toEqual({ width: 1024, height: 768, scale: 1 });
  });

  it("scales a device down to the pane, never up", () => {
    const layout = layoutViewport("tablet", false, { width: 600, height: 700 })!;
    expect(layout.width).toBe(768);
    expect(layout.scale).toBeLessThan(1);
    expect(layout.height * layout.scale).toBeLessThanOrEqual(700);
    expect(layout.width * layout.scale).toBeLessThanOrEqual(600);
  });

  it("gives desktop the pane's height at its width", () => {
    const layout = layoutViewport("desktop", false, { width: 752, height: 600 })!;
    expect(layout.width).toBe(1440);
    expect(layout.scale).toBeCloseTo(0.5);
    expect(layout.height * layout.scale).toBeLessThanOrEqual(600);
    expect(layout.height * layout.scale).toBeGreaterThan(500);
  });

  it("ignores an unknown stored value", () => {
    expect(isViewportId("tablet")).toBe(true);
    expect(isViewportId("watch")).toBe(false);
  });
});
