import type { MouseEvent } from "react";
import { isDraftAgent, type AgentDefinition } from "../../shared/agents.ts";
import { plural } from "../../shared/util.ts";
import { UnreadDot } from "../chat/ChatList.tsx";
import { AgentAvatar } from "../chat/people.tsx";
import { isBoolean, opensElsewhere, SectionHead, useStoredState } from "../layout.tsx";
import { agentPath, NEW_AGENT } from "./nav.ts";
import { useAgents } from "./store.ts";

/**
 * The sidebar's Agents section, which opens and closes as Artifacts does (closed at first): the user's agents by name,
 * each with its badge, job line and whether it is on, the model's proposals marked Draft, and "New agent". Closed, a dot
 * says that proposals wait for review.
 */
export function AgentsNav({ openId, navigate }: { openId: string | undefined; navigate: (path: string) => void }) {
  const { agents } = useAgents();
  const [open, setOpen] = useStoredState("layout.agentsOpen", false, isBoolean);
  const list = agents ?? [];
  const drafts = list.filter(isDraftAgent).length;
  const go = (path: string) => (event: MouseEvent) => {
    if (opensElsewhere(event)) return;
    event.preventDefault();
    navigate(path);
  };
  return (
    <>
      <SectionHead name="Agents" count={list.length} open={open} onToggle={setOpen}>
        {!open && drafts > 0 && <UnreadDot label={`${plural(drafts, "proposed agent")} to review`} />}
      </SectionHead>
      {open && (
        <nav className="agent-list" aria-label="Your agents">
          {list.map((agent) => (
            <AgentLink key={agent.id} agent={agent} active={agent.id === openId} onClick={go(agentPath({ id: agent.id }))} />
          ))}
          <a
            href={agentPath({ id: NEW_AGENT })}
            className={openId === NEW_AGENT ? "nav-item agent-new active" : "nav-item agent-new"}
            onClick={go(agentPath({ id: NEW_AGENT }))}
          >
            <span className="agent-new-plus" aria-hidden="true">
              +
            </span>
            <span className="nav-title">New agent</span>
          </a>
        </nav>
      )}
    </>
  );
}

function AgentLink({ agent, active, onClick }: { agent: AgentDefinition; active: boolean; onClick: (event: MouseEvent) => void }) {
  const draft = isDraftAgent(agent);
  const classes = ["nav-item", "agent-item", active && "active", !agent.enabled && "off", draft && "unread"].filter(Boolean).join(" ");
  return (
    <a href={agentPath({ id: agent.id })} className={classes} onClick={onClick} title={`@${agent.name}: ${agent.job}`}>
      <AgentAvatar badge={agent} />
      <span className="nav-title agent-item-text">
        <span className="agent-item-name">
          @{agent.name}
          {draft ? <span className="pill review">Draft</span> : !agent.enabled && <small> · off</small>}
        </span>
        <small className="agent-item-job">{agent.job}</small>
      </span>
    </a>
  );
}
