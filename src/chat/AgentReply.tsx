import { useRef } from "react";
import type { ChatAgentReplyData } from "../../shared/agents.ts";
import { everyone, type PublishedDetails } from "../../shared/protocol.ts";
import { agentPath, goTo } from "../agents/nav.ts";
import { opensElsewhere } from "../layout.tsx";
import { callerName } from "./agentLines.ts";
import { ArtifactCard } from "./ArtifactCard.tsx";
import { Markdown } from "./Markdown.tsx";
import { MessageActions } from "./MessageActions.tsx";
import { Fold, ItemChips } from "./Fold.tsx";
import { AgentByline, useSharedChat } from "./people.tsx";
import { ReactionChips, type MessageReactions } from "./Reactions.tsx";
import { SentTime } from "./SentTime.tsx";

/** Who gave an agent the turn it answers, as its byline says it. */
function calledByLabel(calledBy: ChatAgentReplyData["calledBy"], run: ChatAgentReplyData["run"]): string {
  if (run?.test) return "a test run";
  if (run?.why === "watch") return "its watch fired";
  if (run?.why === "manual") return "run by hand";
  return calledBy.schedule ? "on its schedule" : `for ${callerName(calledBy)}`;
}

/**
 * One reply of an agent besides pi (a `chat.agent` entry): its badge and name, whose it is and who asked, its text
 * (folded behind "Show more" when long), the records it is built on as chips, the artifacts it published and why it
 * ended early. Its steps show live while it works (AgentTurnLive), then stay in its own session.
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
  const people = useSharedChat();
  // Whose agent it is: it works with their sign-ins and budget.
  const owner = people && everyone(people).find((person) => person.uid === data.ownerUid)?.name;
  const runPath = data.run && agentPath({ id: data.agentId, tab: "runs", run: data.run.dueAt });
  return (
    <div className="agent-reply" ref={content}>
      <AgentByline name={data.name} badge={data} note={["agent", owner && `${owner}'s`, calledByLabel(data.calledBy, data.run)].filter(Boolean).join(" · ")} />
      {data.text && (
        <Fold foldKey={`agent:${data.agentId}:${data.turn}`}>
          <div className="bubble markdown">
            <Markdown text={data.text} />
          </div>
        </Fold>
      )}
      {data.items && <ItemChips items={data.items} />}
      {data.published?.map((artifact) => (
        <ArtifactCard key={`${artifact.artifactId}:${artifact.version}`} artifact={artifact} onOpen={onOpen} />
      ))}
      {data.failed && <div className="chat-error">{data.failed}</div>}
      {runPath && (
        // A run's post: where it came from, opening on how the run got there. A reply to it continues the run.
        <a
          className="run-marker"
          href={runPath}
          onClick={(event) => {
            if (opensElsewhere(event)) return;
            event.preventDefault();
            goTo(runPath);
          }}
        >
          {data.run?.test ? "Test run: nothing was sent or changed" : "From a run"} · See how it got there
        </a>
      )}
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
