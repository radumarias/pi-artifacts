import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { memo, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { CHAT_MESSAGE_KIND, PUBLISH_TOOL, type ChatMessageData, type PublishedDetails } from "../../shared/protocol.ts";
import { SharePanel } from "./SharePanel.tsx";
import { useChat, type RunningTool } from "./useChat.ts";
import { Linkified } from "./Linkified.tsx";
import { Markdown } from "./Markdown.tsx";
import { ModelPicker } from "./ModelPicker.tsx";

interface Props {
  chatId: string;
  /** The signed-in user: their own messages show without a name. */
  uid: string;
  /** Called with the newest artifact this chat published, on load and on every publish. */
  onArtifact: (artifact: PublishedDetails) => void;
  onActivity: () => void;
  /** Called when the user is no longer in this chat (removed, or it is gone): its sidebar entry went too. */
  onGone: () => void;
  /** Called once the user left this chat. */
  onLeft: () => void;
}

function published(entry: EntryRecord): PublishedDetails | undefined {
  if (entry.kind !== "pi.tool-result") return undefined;
  const message = entry.model?.[0] as ToolResultMessage | undefined;
  if (message?.toolName !== PUBLISH_TOOL || message.isError) return undefined;
  const details = message.details as Partial<PublishedDetails> | undefined;
  return details?.artifactId && details.version ? (details as PublishedDetails) : undefined;
}

export function ChatView({ chatId, uid, onArtifact, onActivity, onGone, onLeft }: Props) {
  const { state, connected, people, gone, prompt, abort, setModel } = useChat(chatId);
  const [draft, setDraft] = useState("");
  const [sharing, setSharing] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const lastArtifact = useRef<string>("");

  // Follow new output only while the reader is at the bottom; scrolling up to read stops it,
  // scrolling back down (or sending a message) resumes it. Scroll the list itself, never the page.
  const following = useRef(true);
  const onScroll = () => {
    const el = list.current;
    if (el) following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  useEffect(() => {
    const el = list.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [state.entries.length, state.partial, state.tools]);

  // A finished run may have renamed the chat or published artifacts: refresh the sidebar.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !state.busy) onActivity();
    wasBusy.current = state.busy;
  }, [state.busy, onActivity]);

  useEffect(() => {
    if (gone) onGone();
  }, [gone, onGone]);

  useEffect(() => {
    const latest = state.entries.map(published).filter(Boolean).pop();
    if (!latest) return;
    const key = `${latest.artifactId}:${latest.version}`;
    if (key === lastArtifact.current) return;
    lastArtifact.current = key;
    onArtifact(latest);
  }, [state.entries, onArtifact]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || !prompt(text)) return;
    following.current = true;
    setDraft("");
    // Clicking Send moves focus to the button; keep typing where you were.
    input.current?.focus();
  };

  // Enter sends, Shift+Enter adds a line. Not while an IME is composing (Enter then confirms the text).
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  const isOwner = people?.owner.uid === uid;
  const ownerName = people && !isOwner ? people.owner.name : undefined;
  const others = people ? [people.owner, ...people.members].filter((person) => person.uid !== uid).map((person) => person.name).join(", ") : "";
  return (
    <section className="chat">
      <header className="chat-header">
        <span className="chat-people" title={others}>
          {others && `With ${others}`}
        </span>
        {people && (
          <button type="button" onClick={() => setSharing(!sharing)} aria-expanded={sharing}>
            {isOwner ? "Share" : "People"}
          </button>
        )}
      </header>
      {sharing && people && <SharePanel chatId={chatId} uid={uid} isOwner={isOwner} people={people} onLeft={onLeft} />}
      <div className="messages" ref={list} onScroll={onScroll}>
        {state.entries.length === 0 && !state.busy && (
          <div className="empty-chat">
            <h2>What should we build?</h2>
            <p>Try: “A live crypto dashboard for BTC, ETH and SOL with 24 h change and a 7-day price chart, refreshing every 30 seconds.”</p>
          </div>
        )}
        {state.entries.map((entry) => (
          <Entry key={entry.id} entry={entry} uid={uid} ownerName={ownerName} onOpen={onArtifact} />
        ))}
        {state.partial && <Assistant message={state.partial} />}
        {state.tools.map((tool) => (
          <Running key={tool.toolCallId} tool={tool} />
        ))}
        {state.busy && !state.partial && state.tools.length === 0 && <div className="thinking">Thinking…</div>}
        {state.error && <div className="chat-error">{state.error}</div>}
      </div>
      <ModelPicker model={state.model} thinkingLevel={state.thinkingLevel} disabled={!connected} onChange={setModel} />
      <form className="composer" onSubmit={submit}>
        <textarea
          ref={input}
          // Each chat mounts its own view, so a new or opened chat starts with the cursor here.
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          placeholder={connected ? (others ? "Message everyone and the agent…" : "Describe a dashboard…") : "Connecting…"}
          rows={2}
        />
        {state.busy ? (
          <button type="button" onClick={abort}>
            Stop
          </button>
        ) : (
          <button type="submit" disabled={!connected || !draft.trim()}>
            Send
          </button>
        )}
      </form>
    </section>
  );
}

// Entries never change once committed, so streaming a new reply re-renders only the reply, not the whole history.
const Entry = memo(function Entry({
  entry,
  uid,
  ownerName,
  onOpen,
}: {
  entry: EntryRecord;
  uid: string;
  /** Set when someone other than the owner is viewing: a plain `pi.user` entry, from before chats were shared, is the owner's. */
  ownerName?: string;
  onOpen: (artifact: PublishedDetails) => void;
}) {
  const message = entry.model?.[0];
  if (entry.kind === "pi.user" && message?.role === "user") return <User text={userText(message)} author={ownerName} />;
  if (entry.kind === CHAT_MESSAGE_KIND) {
    const data = entry.data as unknown as ChatMessageData;
    return <User text={data.text} author={data.uid !== uid ? data.name : undefined} />;
  }
  if (entry.kind === "pi.assistant" && message?.role === "assistant") return <Assistant message={message} />;
  if (entry.kind === "pi.tool-result" && message?.role === "toolResult") {
    const artifact = published(entry);
    if (artifact) {
      return (
        <button type="button" className="artifact-card" onClick={() => onOpen(artifact)}>
          <span className="artifact-card-icon">▦</span>
          <span>
            <strong>{artifact.title}</strong>
            <small>Artifact · version {artifact.version} · open preview</small>
          </span>
        </button>
      );
    }
    return <ToolResult message={message} />;
  }
  return null;
});

/** A message's blocks, skipping any slot a stream has not filled yet. */
function blocks<T>(content: string | readonly (T | undefined | null)[]): T[] {
  return typeof content === "string" ? [] : content.filter((b): b is T => b != null);
}

function userText(message: UserMessage): string {
  return typeof message.content === "string" ? message.content : blocks(message.content).map((b) => (b.type === "text" ? b.text : "")).join("");
}

/** A person's message: yours on the right; someone else's on the left, under their name. */
function User({ text, author }: { text: string; author?: string }) {
  if (author === undefined) return <div className="bubble user">{text}</div>;
  return (
    <div className="other">
      <small>{author}</small>
      <div className="bubble peer">{text}</div>
    </div>
  );
}

function Assistant({ message }: { message: AssistantMessage }) {
  return (
    <div className="assistant">
      {blocks(message.content).map((block, i) => {
        if (block.type === "text")
          return block.text ? (
            <div key={i} className="bubble bot markdown">
              <Markdown text={block.text} />
            </div>
          ) : null;
        if (block.type === "toolCall") return <div key={i} className="tool-call">→ {block.name}</div>;
        return null;
      })}
      {message.stopReason === "error" && <div className="chat-error">The model failed: {message.errorMessage ?? "unknown error"}</div>}
      {message.stopReason === "aborted" && <div className="tool-call">Stopped.</div>}
    </div>
  );
}

function ToolResult({ message }: { message: ToolResultMessage }) {
  const text = blocks(message.content).map((b) => (b.type === "text" ? b.text : "[image]")).join("\n");
  return (
    <details className={message.isError ? "tool-result error" : "tool-result"}>
      <summary>
        {message.isError ? "✕" : "✓"} {message.toolName}
      </summary>
      <pre>
        <Linkified text={text.length > 4_000 ? `${text.slice(0, 4_000)}…` : text} />
      </pre>
    </details>
  );
}

function Running({ tool }: { tool: RunningTool }) {
  return (
    <div className="tool-call">
      <span className="spinner" /> {tool.toolName}
      {tool.output && <pre>{tool.output.slice(-600)}</pre>}
    </div>
  );
}
