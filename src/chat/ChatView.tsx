import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent } from "react";
import { baseName, imageBudget, MAX_ATTACHMENTS, type Attachment } from "../../shared/attachments.ts";
import type { Mention } from "../../shared/mentions.ts";
import { MAX_FILE_BYTES } from "../../shared/uploads.ts";
import { errorMessage, formatBytes } from "../../shared/util.ts";
import { api } from "../api.ts";
import { Icon } from "../Icon.tsx";
import { carriesFiles } from "../files/pick.ts";
import { attachmentInput, pastedName, type Pending } from "./attach.ts";
import {
  CHAT_MESSAGE_KIND,
  CHAT_PEOPLE_KIND,
  PUBLISH_TOOL,
  type ChatMessageData,
  type ChatPeople,
  type ChatPeopleData,
  type Person,
  type Presence,
  type PublishedDetails,
  type QueuedMessage,
  type ReplyQuote,
} from "../../shared/protocol.ts";
import { textOf } from "../../shared/canonical.ts";
import { AGENT_NAME, AGENT_TOKEN } from "../../shared/mentions.ts";
import { replyQuote } from "../../shared/replies.ts";
import { MessageActions } from "./MessageActions.tsx";
import { AgentByline, Avatar, SharedChat, tintOf, tintStyle, useSharedChat } from "./people.tsx";
import { ChatCost, PromptCost } from "./Cost.tsx";
import { SharePanel } from "./SharePanel.tsx";
import { promptSpend, totalTime } from "./spend.ts";
import { useChat, waitingOnModel } from "./useChat.ts";
import { Dictation } from "./Dictation.tsx";
import { Markdown } from "./Markdown.tsx";
import { MentionList, MentionText, useMentions } from "./Mentions.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { OrphanResult, StepsProvider, ThoughtStep, ToolStep } from "./Steps.tsx";
import { Thinking } from "./Thinking.tsx";
import { useRevealedText } from "./reveal.ts";

interface Props {
  chatId: string;
  /** The signed-in user: their own messages show without a name. */
  uid: string;
  /** Called with the newest artifact this chat published, on load (`loading`) and on every publish, and with one the user opens. */
  onArtifact: (artifact: PublishedDetails, loading?: boolean) => void;
  onActivity: () => void;
  /** Called once the user left this chat. */
  onLeft: () => void;
}

const GROWS_ITSELF = CSS.supports("field-sizing", "content");

function published(entry: EntryRecord): PublishedDetails | undefined {
  if (entry.kind !== "pi.tool-result") return undefined;
  const message = entry.model?.[0] as ToolResultMessage | undefined;
  if (message?.toolName !== PUBLISH_TOOL || message.isError) return undefined;
  const details = message.details as Partial<PublishedDetails> | undefined;
  return details?.artifactId && details.version ? (details as PublishedDetails) : undefined;
}

export function ChatView({ chatId, uid, onArtifact, onActivity, onLeft }: Props) {
  const { state, connected, people, online, prompt, abort, setModel } = useChat(chatId);
  const [draft, setDraft] = useState("");
  const [sharing, setSharing] = useState(false);
  const attachments = useAttachments(chatId);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const shared = people && people.members.length > 0 ? people : null;
  const mentions = useMentions(chatId, draft, setDraft, input, shared !== null);
  // The message the next one answers, quoted above the composer until it is sent or let go.
  const [replying, setReplying] = useState<ReplyQuote | null>(null);
  const reply = useCallback((quote: ReplyQuote) => {
    setReplying(quote);
    input.current?.focus();
  }, []);
  const picker = useRef<HTMLInputElement>(null);
  const lastArtifact = useRef<string>("");
  // Whether the conversation so far has arrived: publishes in it are not new.
  const loaded = useRef(false);

  // Follow new output only while the reader is at the bottom; scrolling up to read stops it,
  // scrolling back down (or sending a message) resumes it. Scroll the list itself, never the page.
  const following = useRef(true);
  const onScroll = () => {
    const el = list.current;
    if (el) following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  const follow = useCallback(() => {
    const el = list.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, []);
  useEffect(follow, [follow, state.entries.length, state.partial, state.tools, state.queued.length]);

  // A finished run may have saved files (run_python): read them again. The rest of the sidebar follows on its own
  // (useSidebarSocket).
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !state.busy) onActivity();
    wasBusy.current = state.busy;
  }, [state.busy, onActivity]);

  useEffect(() => {
    // The first entries are the conversation as it was (the snapshot); a publish after them is new, even the chat's first.
    const loading = !loaded.current;
    if (state.entries.length > 0) loaded.current = true;
    const latest = state.entries.map(published).filter(Boolean).pop();
    if (!latest) return;
    const key = `${latest.artifactId}:${latest.version}`;
    if (key === lastArtifact.current) return;
    lastArtifact.current = key;
    onArtifact(latest, loading);
  }, [state.entries, onArtifact]);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (attachments.sending || (!text && attachments.pending.length === 0)) return;
    const named = mentions.take(text);
    const replyTo = replying?.id;
    if (attachments.pending.length === 0) {
      if (!prompt(text, undefined, named, replyTo)) return;
    } else if (!(await attachments.send((inputs) => prompt(text, inputs, named, replyTo)))) return;
    following.current = true;
    setDraft("");
    setReplying(null);
    mentions.clear();
    // Clicking Send moves focus to the button; keep typing where you were.
    input.current?.focus();
  };

  // Files dropped on the composer go with the message; anywhere else in the app they only upload (App.tsx).
  const onDragOver = (event: DragEvent) => {
    if (!carriesFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (event: DragEvent) => {
    if (!carriesFiles(event.dataTransfer)) return;
    // Seen by the app's own drop handler, which then only ends its drag.
    event.preventDefault();
    attachments.add([...event.dataTransfer.files]);
  };
  const onPaste = (event: ClipboardEvent) => {
    const files = [...event.clipboardData.files];
    if (files.length === 0) return;
    event.preventDefault();
    attachments.add(files.map((file) => pastedName(file)));
  };

  // Enter sends, Shift+Enter adds a line. Not while an IME is composing (Enter then confirms the text). Escape lets go
  // of the message being replied to.
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentions.onKeyDown(event)) return;
    if (event.key === "Escape" && replying) {
      event.preventDefault();
      setReplying(null);
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };

  // Dictated words join the draft with a space between them.
  // Stable, so the memoized Dictation skips the re-render on every streamed token.
  const dictated = useCallback((text: string) => setDraft((current) => (current && !/\s$/.test(current) ? `${current} ${text}` : current + text)), []);

  // The input grows with what is typed, up to its max-height in styles.css, then scrolls.
  // Browsers with field-sizing do this themselves, and also when the column is resized.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el || GROWS_ITSELF) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  const prompts = useMemo(() => promptSpend(state.entries, state.busy), [state.entries, state.busy]);
  const time = useMemo(() => totalTime(prompts.values()), [prompts]);

  const isOwner = people?.owner.uid === uid;
  const sendLabel = attachments.sending ? "Sending…" : "Send";
  const ownerName = people && !isOwner ? people.owner.name : undefined;
  const mine = online.find((presence) => presence.uid === uid)?.windows ?? 0;
  // Where each reply of the agent's starts: after a person's message, its name goes over it in a shared chat.
  const bylines = useMemo(() => (shared ? agentTurns(state.entries) : new Set<number>()), [shared, state.entries]);
  const agentLast = useMemo(() => shared !== null && endsInAgentTurn(state.entries), [shared, state.entries]);
  const thinking = state.runStartedAt !== undefined && waitingOnModel(state);
  return (
    <SharedChat.Provider value={shared}>
      <section className="chat">
        <header className="chat-header">
          {shared ? (
            <PeopleBar people={shared} online={online} uid={uid} />
          ) : (
            <span className="chat-people">{mine > 1 && `Open in ${mine} of your windows`}</span>
          )}
          <ChatCost usage={state.usage} entries={state.entries} time={time} />
          {people && (
            <button type="button" onClick={() => setSharing(!sharing)} aria-expanded={sharing}>
              {isOwner && !shared ? "Share" : "People"}
            </button>
          )}
        </header>
        {sharing && people && <SharePanel chatId={chatId} uid={uid} isOwner={isOwner} people={people} onLeft={onLeft} />}
        <StepsProvider entries={state.entries} tools={state.tools} busy={state.busy}>
          <div className="messages" ref={list} onScroll={onScroll}>
            {state.entries.length === 0 && !state.busy && (
              <div className="empty-chat">
                <h2>What should we build?</h2>
                <p>Try: “A live crypto dashboard for BTC, ETH and SOL with 24 h change and a 7-day price chart, refreshing every 30 seconds.”</p>
              </div>
            )}
            {state.entries.map((entry) => {
              const spend = prompts.get(entry.id);
              return (
                <Fragment key={entry.id}>
                  {bylines.has(entry.id) && <AgentByline />}
                  <Entry entry={entry} uid={uid} ownerName={ownerName} onOpen={onArtifact} onReply={reply} />
                  {spend && <PromptCost spend={spend} />}
                </Fragment>
              );
            })}
            {shared && !agentLast && (state.partial || thinking) && <AgentByline />}
            {state.partial && <Assistant message={state.partial} streaming onGrow={follow} />}
            {thinking && <Thinking since={state.runStartedAt!} />}
            {state.error && <div className="chat-error">{state.error}</div>}
            <Queue queued={state.queued} uid={uid} />
          </div>
        </StepsProvider>
        <form className="composer" onSubmit={submit} onDragOver={onDragOver} onDrop={onDrop}>
          {attachments.error && <div className="chat-error">{attachments.error}</div>}
          <MentionList mentions={mentions} />
          {replying && (
            <div className="replying">
              <ReplyQuoteView quote={replying} />
              <button type="button" className="icon-button" onClick={() => setReplying(null)} title="Do not reply to it" aria-label="Do not reply to it">
                ×
              </button>
            </div>
          )}
          {/* A click anywhere in the box but a button puts the cursor in the input. */}
          <div className="composer-box" onClick={(e) => (e.target as Element).closest("button") || input.current?.focus()}>
            {attachments.pending.length > 0 && (
              <div className="pending-attachments">
                {attachments.pending.map((item) => (
                  <span key={item.id} className="pending-attachment" title={`${item.file.name} · ${formatBytes(item.file.size)}`}>
                    {item.preview ? <img src={item.preview} alt="" /> : <span className="file-icon">▤</span>}
                    <span className="pending-name">{item.file.name}</span>
                    <button type="button" onClick={() => attachments.remove(item.id)} disabled={attachments.sending} aria-label={`Remove ${item.file.name}`}>
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="composer-row">
              <textarea
                ref={input}
                // Each chat mounts its own view, so a new or opened chat starts with the cursor here.
                autoFocus
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  mentions.track();
                }}
                onSelect={mentions.track}
                onKeyDown={onKey}
                onPaste={onPaste}
                placeholder={
                  !connected
                    ? "Connecting…"
                    : shared
                      ? `Message everyone; ${AGENT_TOKEN} asks ${AGENT_NAME}, and @ names a file or artifact…`
                      : "Describe a dashboard, or type @ to name a file or artifact…"
                }
                rows={1}
              />
              {state.busy ? (
                <button type="button" className="icon-button" onClick={abort} title="Stop" aria-label="Stop">
                  <Icon>
                    <rect x="4" y="4" width="16" height="16" rx="3" fill="currentColor" stroke="none" />
                  </Icon>
                </button>
              ) : (
                <button
                  type="submit"
                  className="icon-button"
                  disabled={!connected || attachments.sending || (!draft.trim() && attachments.pending.length === 0)}
                  title={sendLabel}
                  aria-label={sendLabel}
                >
                  <Icon>
                    <path d="M20 5v7a3 3 0 0 1-3 3H5M9 11l-4 4 4 4" />
                  </Icon>
                </button>
              )}
            </div>
          </div>
          <div className="composer-tools">
            <button
              type="button"
              className="icon-button"
              onClick={() => picker.current?.click()}
              disabled={attachments.sending || attachments.pending.length >= MAX_ATTACHMENTS}
              title="Attach images or files"
              aria-label="Attach images or files"
            >
              <Icon>
                <path d="M12 4v16M4 12h16" />
              </Icon>
            </button>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                attachments.add([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              className="icon-button mention-button"
              onClick={mentions.insertAt}
              title={shared ? `Ask ${AGENT_NAME}, or name a file or artifact (@)` : "Name a file or artifact (@)"}
              aria-label={shared ? `Ask ${AGENT_NAME}, or name a file or artifact` : "Name a file or artifact"}
            >
              @
            </button>
            <Dictation disabled={!connected} onText={dictated} />
            <ModelPicker
              model={state.model}
              thinkingLevel={state.thinkingLevel}
              disabled={!connected}
              attachingImages={attachments.pending.some((item) => item.preview)}
              onChange={setModel}
            />
            {/* Always laid out, so the pickers don't move when a run starts or ends. */}
            <span className={state.busy || attachments.sending ? "spinner" : "spinner idle"} aria-hidden="true" />
          </div>
        </form>
      </section>
    </SharedChat.Provider>
  );
}

// Entries never change once committed, so streaming a new reply re-renders only the reply, not the whole history.
const Entry = memo(function Entry({
  entry,
  uid,
  ownerName,
  onOpen,
  onReply,
}: {
  entry: EntryRecord;
  uid: string;
  /** Set when someone other than the owner is viewing: a plain `pi.user` entry, from before chats were shared, is the owner's. */
  ownerName?: string;
  onOpen: (artifact: PublishedDetails) => void;
  onReply: (quote: ReplyQuote) => void;
}) {
  const people = useSharedChat();
  const message = entry.model?.[0];
  // What a reply to it quotes: none for a message from before replies (pi.user).
  const quote = replyQuote(entry);
  const answer = quote ? () => onReply(quote) : undefined;
  if (entry.kind === "pi.user" && message?.role === "user") {
    const author = ownerName === undefined ? undefined : { uid: people?.owner.uid ?? "", name: ownerName };
    return <User text={userText(message)} author={author} uid={uid} />;
  }
  if (entry.kind === CHAT_MESSAGE_KIND) {
    const data = entry.data as unknown as ChatMessageData;
    return (
      <User
        text={data.text}
        author={data.uid !== uid ? data : undefined}
        uid={uid}
        attachments={data.attachments}
        mentions={data.mentions}
        replyTo={data.replyTo}
        // In the transcript, a message that called the agent was picked up: it was placed in its run.
        picked={data.summoned}
        onReply={answer}
      />
    );
  }
  if (entry.kind === CHAT_PEOPLE_KIND) {
    const data = entry.data as unknown as ChatPeopleData;
    const [them, you] = PEOPLE_EVENTS[data.event];
    return <div className="chat-notice">{data.uid === uid ? `You ${you}` : `${data.name} ${them}`}</div>;
  }
  if (entry.kind === "pi.assistant" && message?.role === "assistant") {
    return <Assistant message={message} onReply={answer} />;
  }
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
    return <OrphanResult message={message} />;
  }
  return null;
});

/** Entries the app shows nothing for: they do not end an agent's reply, or start one. */
function shown(entry: EntryRecord): boolean {
  return entry.kind === CHAT_MESSAGE_KIND || entry.kind === CHAT_PEOPLE_KIND || entry.kind === "pi.user" || isAgent(entry);
}

function isAgent(entry: EntryRecord): boolean {
  return entry.kind === "pi.assistant" || entry.kind === "pi.tool-result";
}

/** The agent's entries that start one of its replies: the first of its own after anything else the chat shows. */
function agentTurns(entries: readonly EntryRecord[]): Set<number> {
  const starts = new Set<number>();
  let inTurn = false;
  for (const entry of entries) {
    if (!shown(entry)) continue;
    if (isAgent(entry) && !inTurn) starts.add(entry.id as number);
    inTurn = isAgent(entry);
  }
  return starts;
}

function endsInAgentTurn(entries: readonly EntryRecord[]): boolean {
  const last = entries.findLast(shown);
  return last !== undefined && isAgent(last);
}

/** Who is in a shared chat, everyone with their colour, and a dot for those who have it open now. */
function PeopleBar({ people, online, uid }: { people: ChatPeople; online: Presence[]; uid: string }) {
  // Each open window is a socket; someone no longer in the chat may still show for a moment, so only people in it count.
  const windows = new Map(online.map((presence) => [presence.uid, presence.windows]));
  const everyone = [people.owner, ...people.members];
  const here = everyone.filter((person) => windows.has(person.uid)).length;
  return (
    <div className="people-bar" aria-label={`${everyone.length} people, ${here} here now`}>
      {everyone.map((person) => {
        const count = windows.get(person.uid) ?? 0;
        const you = person.uid === uid;
        const state = count === 0 ? "away" : count > 1 ? `here now, in ${count} windows` : "here now";
        return (
          <span key={person.uid} className={count ? "person online" : "person"} title={`${person.name}${you ? " (you)" : ""}: ${state}`}>
            <Avatar name={person.name} tint={tintOf(people, person.uid)} online={count > 0} />
            <span className="person-name">
              {you ? "You" : person.name}
              {count > 1 && <small> ×{count}</small>}
            </span>
          </span>
        );
      })}
    </div>
  );
}

/** Each notice as said of someone else, and of the viewer (who may have been removed and invited back). */
const PEOPLE_EVENTS: Record<ChatPeopleData["event"], readonly [string, string]> = {
  joined: ["joined the chat", "joined the chat"],
  rejoined: ["joined again from another window or device", "joined again from another window or device"],
  left: ["left the chat", "left the chat"],
  removed: ["was removed from the chat", "were removed from the chat"],
  stopped: [`stopped ${AGENT_NAME}`, `stopped ${AGENT_NAME}`],
};

/**
 * Messages sent while the agent was busy, below everything it is doing now, oldest first: faded and marked queued,
 * with their place when more than one waits. Each leaves the queue for the transcript when its turn comes.
 */
function Queue({ queued, uid }: { queued: QueuedMessage[]; uid: string }) {
  return queued.map((message, i) => {
    const mine = message.uid === uid;
    return (
      <div key={message.id} className={mine ? "queued mine" : "queued"}>
        <User
          text={message.text}
          author={mine ? undefined : message}
          uid={uid}
          attachments={message.attachments}
          mentions={message.mentions}
          replyTo={message.replyTo}
        />
        <small className="queued-label">{queued.length > 1 ? `Queued · ${i + 1} of ${queued.length}` : "Queued"}</small>
      </div>
    );
  });
}

/** A message's blocks, skipping any slot a stream has not filled yet. */
function blocks<T>(content: string | readonly (T | undefined | null)[]): T[] {
  return typeof content === "string" ? [] : content.filter((b): b is T => b != null);
}

function userText(message: UserMessage): string {
  return typeof message.content === "string" ? message.content : blocks(message.content).map((b) => (b.type === "text" ? b.text : "")).join("");
}

/**
 * A person's message: yours on the right; someone else's on the left, under their name. Attachments show above the
 * text, and the message it answers above that. In a shared chat each person's messages have their colour, and one
 * that called the agent shows, once `picked`, that the agent took it.
 */
function User({
  text,
  author,
  uid,
  attachments = [],
  mentions,
  replyTo,
  picked,
  onReply,
}: {
  text: string;
  /** Undefined for the viewer's own message. */
  author?: Person;
  uid: string;
  attachments?: Attachment[];
  mentions?: Mention[];
  replyTo?: ReplyQuote;
  picked?: boolean;
  onReply?: () => void;
}) {
  const people = useSharedChat();
  const content = useRef<HTMLDivElement>(null);
  const mine = author === undefined;
  const tint = people ? tintOf(people, author?.uid ?? uid) : undefined;
  const files = attachments.length > 0 && (
    <div className={mine ? "attachments mine" : "attachments"}>
      {attachments.map((attachment) => (
        <Attached key={attachment.path} attachment={attachment} />
      ))}
    </div>
  );
  const bubble = text && (
    <div className={mine ? "bubble user" : "bubble peer"}>
      {replyTo && <ReplyQuoteView quote={replyTo} />}
      <MentionText text={text} mentions={mentions} />
    </div>
  );
  const reaction = picked && (
    <div className={mine ? "message-foot mine" : "message-foot"}>
      <span className="reaction" title={`${AGENT_NAME} picked this up`}>
        <span aria-hidden="true">👀</span>
        <span className="sr-only">{AGENT_NAME} picked this up</span>
      </span>
    </div>
  );
  return (
    <div
      ref={content}
      className={[mine ? "message mine" : "message other", tint !== undefined && "tinted"].filter(Boolean).join(" ")}
      style={tint === undefined ? undefined : tintStyle(tint)}
    >
      {!mine && (
        <div className="byline">
          {tint !== undefined && <Avatar name={author.name} tint={tint} />}
          <strong>{author.name}</strong>
        </div>
      )}
      {files}
      {bubble && (
        <div className="bubble-row">
          {bubble}
          {onReply && <MessageActions content={content} text={text} onReply={onReply} floating />}
        </div>
      )}
      {reaction}
    </div>
  );
}

/** The message a reply answers: who wrote it, in their colour, and the start of it. */
function ReplyQuoteView({ quote }: { quote: ReplyQuote }) {
  const people = useSharedChat();
  const style = "agent" in quote || !people ? undefined : tintStyle(tintOf(people, quote.uid));
  return (
    <div className={"agent" in quote ? "reply-quote agent" : "reply-quote"} style={style}>
      <strong>{quote.name}</strong> <span>{quote.text}</span>
    </div>
  );
}

const SHOWN: Record<Attachment["shown"], string> = {
  image: "the agent sees the image",
  text: "the agent reads its text",
  path: "the agent got its name only; its tools can open it",
};

function Attached({ attachment }: { attachment: Attachment }) {
  const name = baseName(attachment.path);
  const title = `${attachment.path} · ${formatBytes(attachment.size)} · ${SHOWN[attachment.shown]}`;
  if (attachment.thumb) return <img className="attachment-thumb" src={attachment.thumb} alt={name} title={title} />;
  return (
    <span className="attachment-chip" title={title}>
      <span className="file-icon">▤</span> {name}
    </span>
  );
}

/** Files waiting in the composer, and sending them: uploaded to the chat, then named in the message with what the model sees. */
function useAttachments(chatId: string) {
  const [pending, setPending] = useState<Pending[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const live = useRef(pending);
  live.current = pending;
  // Each chat mounts its own view: its previews go with it.
  useEffect(() => () => live.current.forEach(release), []);

  const add = (files: File[]) => {
    if (files.length === 0) return;
    const large = files.filter((file) => file.size > MAX_FILE_BYTES).map((file) => file.name);
    const room = MAX_ATTACHMENTS - live.current.length;
    const fitting = files.filter((file) => file.size <= MAX_FILE_BYTES);
    const added = fitting.slice(0, Math.max(0, room)).map((file) => ({
      id: crypto.randomUUID(),
      file,
      preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
    }));
    setPending((list) => [...list, ...added]);
    const problems = [
      large.length ? `${large.join(", ")} ${large.length === 1 ? "is" : "are"} over ${formatBytes(MAX_FILE_BYTES)}.` : "",
      fitting.length > added.length ? `A message takes at most ${MAX_ATTACHMENTS} files.` : "",
    ].filter(Boolean);
    setError(problems.length ? problems.join(" ") : undefined);
  };

  const remove = (id: string) => {
    const item = live.current.find((p) => p.id === id);
    if (item) release(item);
    setPending((list) => list.filter((p) => p.id !== id));
  };

  /** Upload the files and hand `prompt` what goes with the message. True once it went; on a failure the files stay, with the error. */
  const send = async (prompt: (inputs: Awaited<ReturnType<typeof attachmentInput>>[]) => boolean): Promise<boolean> => {
    const items = live.current;
    setSending(true);
    setError(undefined);
    try {
      const { paths } = await api.attach(
        chatId,
        items.map(({ file }) => ({ file, path: file.name })),
      );
      const budget = imageBudget(items.filter(({ file }) => file.type.startsWith("image/")).length);
      const inputs = await Promise.all(items.map(({ file }, i) => attachmentInput(file, paths[i], budget)));
      if (!prompt(inputs)) throw new Error("Not connected; try again in a moment.");
      items.forEach(release);
      setPending((list) => list.filter((p) => !items.includes(p)));
      return true;
    } catch (e) {
      setError(`Could not send the files: ${errorMessage(e)}`);
      return false;
    } finally {
      setSending(false);
    }
  };

  return { pending, sending, error, add, remove, send };
}

function release(item: Pending): void {
  if (item.preview) URL.revokeObjectURL(item.preview);
}

/** A streaming answer's text, revealed a little at a time between the steps it arrives in. */
function RevealedMarkdown({ text, onGrow }: { text: string; onGrow?: () => void }) {
  return <Markdown text={useRevealedText(text, onGrow)} />;
}

/**
 * A reply: its text, and a collapsed panel for each thought and tool call in it. `streaming` while the model writes it,
 * with `onGrow` called as its text is revealed.
 */
function Assistant({
  message,
  streaming = false,
  onGrow,
  onReply,
}: {
  message: AssistantMessage;
  streaming?: boolean;
  onGrow?: () => void;
  onReply?: () => void;
}) {
  const content = useRef<HTMLDivElement>(null);
  // What a copy pastes as plain text: its Markdown. Not while it streams, when it has no actions.
  const text = streaming ? "" : textOf(blocks(message.content), "\n\n");
  return (
    <div className="assistant" ref={content}>
      {/* By the block's own index, which stays the same once the message lands, so an opened thought stays open. */}
      {message.content.map((block, i) => {
        if (!block) return null;
        if (block.type === "text")
          return block.text ? (
            <div key={i} className="bubble bot markdown">
              {streaming ? <RevealedMarkdown text={block.text} onGrow={onGrow} /> : <Markdown text={block.text} />}
            </div>
          ) : null;
        if (block.type === "toolCall") return <ToolStep key={i} call={block} streaming={streaming} />;
        if (block.type === "thinking" && !block.redacted && block.thinking.trim())
          return <ThoughtStep key={i} openKey={`${message.timestamp}:${i}`} text={block.thinking} />;
        return null;
      })}
      {message.stopReason === "error" && <div className="chat-error">The model failed: {message.errorMessage ?? "unknown error"}</div>}
      {message.stopReason === "aborted" && <div className="tool-call">Stopped.</div>}
      {text && <MessageActions content={content} text={text} onReply={onReply} />}
    </div>
  );
}
