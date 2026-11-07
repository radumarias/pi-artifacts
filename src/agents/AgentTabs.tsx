import { SAVE_FIRST } from "./glance.ts";

/** The agent page's tab bar. While the open tab has changes not saved, the others are held, so switching never drops them. */
export function AgentTabs({
  tabs,
  current,
  dirty,
  open,
}: {
  tabs: readonly { id: string; label: string }[];
  current: string;
  dirty: boolean;
  open: (id: string) => void;
}) {
  if (tabs.length < 2) return null;
  return (
    <nav className="agent-tabs" role="tablist" aria-label="Agent">
      {tabs.map((each) => {
        const held = dirty && each.id !== current;
        return (
          <button
            key={each.id}
            type="button"
            role="tab"
            aria-selected={each.id === current}
            className={each.id === current ? "agent-tab active" : "agent-tab"}
            disabled={held}
            title={held ? SAVE_FIRST : undefined}
            onClick={() => open(each.id)}
          >
            {each.label}
          </button>
        );
      })}
    </nav>
  );
}
