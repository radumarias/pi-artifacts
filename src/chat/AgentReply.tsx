import { useRef } from "react";
import type { ChatAgentReplyData } from "../../shared/agents.ts";
import type { PublishedDetails } from "../../shared/protocol.ts";
import { ArtifactCard } from "./ArtifactCard.tsx";
import { Markdown } from "./Markdown.tsx";
import { MessageActions } from "./MessageActions.tsx";
import { AgentByline } from "./people.tsx";
import { ReactionChips, type MessageReactions } from "./Reactions.tsx";
import { SentTime } from "./SentTime.tsx";

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
      <AgentByline name={data.name} badge={data} note={`agent · ${calledByLabel(data.calledBy)}`} />
      {data.text && (
        <div className="bubble markdown">
          <Markdown text={data.text} />
        </div>
      )}
      {data.published?.map((artifact) => (
        <ArtifactCard key={`${artifact.artifactId}:${artifact.version}`} artifact={artifact} onOpen={onOpen} />
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
