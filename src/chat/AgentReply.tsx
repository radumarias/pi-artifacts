import { useMemo, useRef, useState } from "react";
import type { ChatAgentReplyData } from "../../shared/agents.ts";
import { offerOf } from "../../shared/offers.ts";
import { everyone, type PublishedDetails } from "../../shared/protocol.ts";
import { errorMessage } from "../../shared/util.ts";
import { api } from "../api.ts";
import { agentPath } from "../agents/nav.ts";
import { AppLink } from "../layout.tsx";
import { calledByLabel, opensRun, runMarkerText } from "./agentLines.ts";
import { ArtifactCard } from "./ArtifactCard.tsx";
import { Markdown } from "./Markdown.tsx";
import { MessageActions } from "./MessageActions.tsx";
import { Fold, ItemChips } from "./Fold.tsx";
import { OfferRow } from "./Offer.tsx";
import { AgentByline, useSharedChat } from "./people.tsx";
import { ReactionChips, type MessageReactions } from "./Reactions.tsx";
import { SentTime } from "./SentTime.tsx";

/**
 * Where a reply built on private servers came from, as the app recorded its calls: "from Ana's calendar · posted by
 * Ana". `ownerName` is the agent's owner's, as the chat's people say it; none in a chat of the viewer's alone.
 */
export function sourceLine(data: Pick<ChatAgentReplyData, "sources" | "postedBy">, ownerName: string | undefined): string | null {
  if (!data.sources?.length) return null;
  const posted = data.postedBy ? ` · posted by ${ownerName ?? "you"}` : "";
  return `from ${ownerName ? `${ownerName}'s` : "your"} ${data.sources.join(", ")}${posted}`;
}

/**
 * One reply of an agent besides pi (a `chat.agent` entry): its badge and name, whose it is and who asked, its text
 * (folded behind "Show more" when long), the records it is built on as chips, the artifacts it published and why it
 * ended early. Its steps show live while it works (AgentTurnLive), then stay in its own session.
 */
export function AgentReply({
  data,
  chatId,
  viewerUid,
  reactions,
  onReply,
  onOpen,
  entry,
  onOfferYes,
}: {
  data: ChatAgentReplyData;
  /** The chat it is in: the run's page leads back to it, and a reply nobody asked for offers to mute its agent there. */
  chatId: string;
  /** Who is looking: only the agent's owner gets the link to the run's page, which only they can open. */
  viewerUid: string;
  reactions: MessageReactions | null;
  onReply?: () => void;
  onOpen: (artifact: PublishedDetails) => void;
  /** Its entry in the transcript, which the answer to its offered next step is remembered by. */
  entry?: number;
  /** On the chat's latest offer, for its owner: what Yes does (OfferRow). */
  onOfferYes?: () => boolean;
}) {
  const content = useRef<HTMLDivElement>(null);
  const people = useSharedChat();
  // Whose agent it is: it works with their sign-ins and budget.
  const owner = people && everyone(people).find((person) => person.uid === data.ownerUid)?.name;
  // In a shared chat whose people no longer list the owner (they left), never "your": the viewer is not the owner.
  const source = sourceLine(data, people ? (owner ?? "its owner") : undefined);
  // The next step it offers, shown under the reply without its line in the text.
  const offered = useMemo(() => offerOf(data.text), [data.text]);
  const said = offered ? offered.body : data.text;
  const marker = runMarkerText(data);
  const runPath = data.run && agentPath({ id: data.agentId, tab: "runs", run: data.run.dueAt, chat: chatId });
  return (
    <div className="agent-reply" ref={content}>
      <AgentByline name={data.name} badge={data} note={["agent", owner && `${owner}'s`, calledByLabel(data)].filter(Boolean).join(" · ")} />
      {said && (
        <Fold foldKey={`agent:${data.agentId}:${data.turn}`}>
          <div className="bubble markdown">
            <Markdown text={said} />
          </div>
        </Fold>
      )}
      {data.items && <ItemChips items={data.items} />}
      {source && (
        <div className="source-chip" title="It read servers its owner does not share with the chat; only this reply was posted">
          {source}
        </div>
      )}
      {data.published?.map((artifact) => (
        <ArtifactCard key={`${artifact.artifactId}:${artifact.version}`} artifact={artifact} onOpen={onOpen} />
      ))}
      {offered && <OfferRow offer={offered.offer} entry={entry} onYes={onOfferYes} />}
      {data.failed && <div className="chat-error">{data.failed}</div>}
      {runPath &&
        (opensRun(data, viewerUid) ? (
          // A run's post, or a reply continuing it: where it came from, opening on how the run got there.
          <AppLink path={runPath} className="run-marker">
            {marker} · See how it got there
          </AppLink>
        ) : (
          <span className="run-marker">{marker}</span>
        ))}
      {data.calledBy.unprompted && <MuteRow chatId={chatId} agentId={data.agentId} name={data.name} />}
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

/**
 * Under a reply nobody asked for: Mute, for anyone in the chat, so the agent posts nothing unprompted here again. Its
 * owner, or the chat's, can unmute it from its menu in the people bar or the chat's agent settings.
 */
function MuteRow({ chatId, agentId, name }: { chatId: string; agentId: string; name: string }) {
  const [state, setState] = useState<"idle" | "muting" | "muted">("idle");
  const [error, setError] = useState<string>();
  const mute = async () => {
    setState("muting");
    setError(undefined);
    try {
      await api.muteChatAgent(chatId, agentId, true);
      setState("muted");
    } catch (e) {
      setError(errorMessage(e));
      setState("idle");
    }
  };
  return (
    <div className="mute-row">
      <span className="pill unprompted">Nobody asked</span>
      {state === "muted" ? (
        <span>@{name} won't speak up unasked here again.</span>
      ) : (
        <button type="button" className="link-button" onClick={mute} disabled={state === "muting"}>
          {state === "muting" ? "Muting…" : `Mute @${name} here`}
        </button>
      )}
      {error && <span className="chat-error">{error}</span>}
    </div>
  );
}
