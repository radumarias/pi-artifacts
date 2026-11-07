import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentTabs } from "../src/agents/AgentTabs.tsx";

const tabs = [
  { id: "setup", label: "Setup" },
  { id: "workflow", label: "Workflow" },
  { id: "runs", label: "Runs" },
];

describe("the agent page's tabs", () => {
  it("hold the other tabs while the open one has changes not saved", () => {
    const open = () => {};
    expect(renderToStaticMarkup(<AgentTabs tabs={tabs} current="setup" dirty={false} open={open} />)).not.toContain("disabled");
    const dirty = renderToStaticMarkup(<AgentTabs tabs={tabs} current="setup" dirty open={open} />);
    // Every tab but the open one is held, with the reason.
    expect(dirty.match(/disabled=""/g)).toHaveLength(2);
    expect(dirty).toContain('title="Save or undo your changes first"');
    expect(dirty).toMatch(/aria-selected="true"[^>]*>Setup</);
  });
});
