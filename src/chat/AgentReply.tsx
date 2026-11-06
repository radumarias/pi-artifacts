import { useRef, type CSSProperties } from "react";
import type { AgentColor, ChatAgentReplyData } from "../../shared/agents.ts";
import type { PublishedDetails } from "../../shared/protocol.ts";
import { Markdown } from "./Markdown.tsx";
import { MessageActions } from "./MessageActions.tsx";
import { ReactionChips, type MessageReactions } from "./Reactions.tsx";
import { SentTime } from "./SentTime.tsx";

/** An agent's badge besides pi's: its own letters on its colour, square-cornered as pi's is. `working` adds a dot. */
export function AgentBadge({ avatar, color, working = false }: { avatar: string; color: AgentColor; working?: boolean }) {
  return (
    <span className="avatar agent toned" style={{ "--tone": `var(--agent-${color})` } as CSSProperties} aria-hidden="true">
      {avatar}
      {working && <i className="presence working" />}
    </span>
  );
}

/** Who gave an agent the turn it answers, as its byline says it. */
function calledByLabel(calledBy: ChatAgentReplyData["calledBy"]): string {
  if (calledBy.schedule) return "on its schedule";
  return calledBy.agentId ? `for @${calledBy.name}` : `for ${calledBy.name}`;
}

/**
 * One reply of an agent besides pi (a `chat.agent` entry): its badge and name, who asked, its text, the artifacts it
 * published and why it ended early. Its steps stay in its own session.
 */
export function AgentReply({
  data,
  reactions,
  onReply,
  onOpen,
}: {
  data: ChatAgentReplyData;
  reactions: MessageReactions | null;
  onReply?: () => void;
  onOpen: (artifact: PublishedDetails) => void;
}) {
  const content = useRef<HTMLDivElement>(null);
  return (
    <div className="agent-reply" ref={content}>
      <div className="byline agent">
        <AgentBadge avatar={data.avatar} color={data.color} />
        <strong>@{data.name}</strong>
        <small>agent · {calledByLabel(data.calledBy)}</small>
      </div>
      {data.text && (
        <div className="bubble markdown">
          <Markdown text={data.text} />
        </div>
      )}
      {data.published?.map((artifact) => (
        <button key={`${artifact.artifactId}:${artifact.version}`} type="button" className="artifact-card" onClick={() => onOpen(artifact)}>
          <span className="artifact-card-icon">▦</span>
          <span>
            <strong>{artifact.title}</strong>
            <small>Artifact · version {artifact.version} · open preview</small>
          </span>
        </button>
      ))}
      {data.failed && <div className="chat-error">{data.failed}</div>}
      {data.text && (
        <>
          <ReactionChips reactions={reactions} />
          <div className="message-foot">
            <MessageActions content={content} text={data.text} reactions={reactions} onReply={onReply} />
            <SentTime at={data.endedAt} />
          </div>
        </>
      )}
    </div>
  );
}
