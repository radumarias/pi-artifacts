import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { CHAT_AGENT_KIND, type ChatAgentReplyData } from "../../shared/agents.ts";
import { baseName, imageBudget, MAX_ATTACHMENTS, type Attachment } from "../../shared/attachments.ts";
import { MAX_FILE_BYTES } from "../../shared/uploads.ts";
import { errorMessage, formatBytes } from "../../shared/util.ts";
import { api } from "../api.ts";
import { Icon } from "../Icon.tsx";
import { carriesFiles } from "../files/pick.ts";
import { attachmentInput, pastedName, type Pending } from "./attach.ts";
import {
  CHAT_MESSAGE_KIND,
  CHAT_PEOPLE_KIND,
  everyone,
  incomingKey,
  type AutoPick,
  type ToolPickNote,
  type ChatMessageData,
  type ChatPeople,
  type ChatPeopleData,
  type IncomingAttachment,
  type IncomingMessage,
  type Person,
  type Presence,
  type PublishedDetails,
  type QueuedMessage,
  type ReplyQuote,
} from "../../shared/protocol.ts";
import { textOf } from "../../shared/canonical.ts";
import { AGENT_NAME, AGENT_TOKEN, type Mention } from "../../shared/mentions.ts";
import { replyQuote } from "../../shared/replies.ts";
import { MessageActions } from "./MessageActions.tsx";
import { Compact, useCompact, useSwipeReveal } from "./gestures.ts";
import { calendarDay, DaySeparator, SentTime } from "./SentTime.tsx";
import { ReactionChips, ReactionsContext, useMessageReactions, type MessageReactions } from "./Reactions.tsx";
import { isReactable, type EntryReactions } from "../../shared/reactions.ts";
import { AgentAvatar, AgentByline, Avatar, SharedChat, tintOf, tintStyle, useSharedChat } from "./people.tsx";
import { MenuButton } from "../layout.tsx";
import { AutoPicked, ToolsPicked } from "./AutoPick.tsx";
import { ChatCost, PromptCost } from "./Cost.tsx";
import { ContextMeter } from "./Context.tsx";
import { ChatPromptButton } from "../SystemPrompt.tsx";
import { SharePanel } from "./SharePanel.tsx";
import { promptSpend, totalTime } from "./spend.ts";
import { useChat, waitingOnModel } from "./useChat.ts";
import { ComposerMore } from "./ComposerMore.tsx";
import { Dictation } from "./Dictation.tsx";
import { ownMessages, useHistory } from "./history.ts";
import { AgentReply } from "./AgentReply.tsx";
import { Markdown } from "./Markdown.tsx";
import { MentionList, MentionText, useMentions } from "./Mentions.tsx";
import { NotifyButton } from "./notify.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { OrphanResult, StepRun, StepsProvider } from "./Steps.tsx";
import { endedEarly, stepRuns, streamingSteps, type MessageSteps, type StepRuns, type StreamingSteps } from "./stepRuns.ts";
import { Thinking } from "./Thinking.tsx";
import { useRevealedText } from "./reveal.ts";
import { blocks, firstNew, isAgent, openHints, published, sentAt, shown, userText } from "./entries.ts";

interface Props {
  chatId: string;
  /** The chat's name, at the start of its header. */
  title?: string;
  /** The signed-in user: their own messages show on the right, with no name over them. */
  uid: string;
  /** When the user had last seen the chat, if something came in since: a "New" line goes over the first such message. */
  newSince?: number;
  /** Called with the newest artifact this chat published, on load (`loading`) and on every publish, and with one the user opens. */
  onArtifact: (artifact: PublishedDetails, loading?: boolean) => void;
  onActivity: () => void;
  /** Called once the user left this chat. */
  onLeft: () => void;
  /** Opens the app's menu (the sidebar), on a phone or a narrow window, where the header has a button for it. */
  onMenu?: () => void;
}

const GROWS_ITSELF = CSS.supports("field-sizing", "content");

/** Whether the conversation is scrolled to (near) its end, where new output is followed. */
const atBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < 80;

export function ChatView({ chatId, title, uid, newSince, onArtifact, onActivity, onLeft, onMenu }: Props) {
  const { state, connected, people, online, prompt, abort, setModel, auto, reactions, react, hints, dropHint, agents } = useChat(chatId);
  // pi, or an agent of the chat, is working or has turns waiting: Stop stops them all.
  const working = state.busy || agents.some((agent) => agent.busy || agent.queued);
  const chatReactions = useMemo(() => ({ uid, react }), [uid, react]);
  const [draft, setDraft] = useState("");
  const [sharing, setSharing] = useState(false);
  const shareButton = useRef<HTMLButtonElement>(null);
  // Closed from inside the panel: back to the button that opens it, so the keyboard does not lose its place.
  const closeSharing = () => {
    setSharing(false);
    shareButton.current?.focus();
  };
  const attachments = useAttachments(chatId);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const shared = people && people.members.length > 0 ? people : null;
  const mentions = useMentions(chatId, draft, setDraft, input, shared, uid);
  // The viewer's own earlier messages, to bring back into the composer (Up, or the "more" menu). Who owns the chat must be
  // known first: a plain `pi.user` entry is the owner's.
  const isOwner = people?.owner.uid === uid;
  const history = useMemo(() => (people ? ownMessages(state.entries, uid, isOwner) : []), [people, state.entries, uid, isOwner]);
  const recalling = useHistory(history, draft, setDraft, input, (message) => mentions.restore(message.text, message.mentions));
  // The message the next one answers, quoted above the composer until it is sent or let go.
  const [replying, setReplying] = useState<ReplyQuote | null>(null);
  const reply = useCallback((quote: ReplyQuote) => {
    setReplying(quote);
    input.current?.focus();
  }, []);
  // "Ask pi" under a message of the viewer's that looks meant for the agent: a reply to it that calls the agent.
  const askAgent = useCallback(
    (entry: number) => {
      if (!prompt(AGENT_TOKEN, undefined, undefined, entry)) return;
      dropHint(entry);
      following.current = true;
    },
    [prompt, dropHint],
  );
  const picker = useRef<HTMLInputElement>(null);
  const lastArtifact = useRef<string>("");
  // Whether the conversation so far has arrived: publishes in it are not new.
  const loaded = useRef(false);

  // Follow new output only while the reader is at the bottom; scrolling up to read stops it,
  // scrolling back down (or sending a message) resumes it. Scroll the list itself, never the page.
  const following = useRef(true);
  const onScroll = () => {
    const el = list.current;
    if (el) following.current = atBottom(el);
  };
  const follow = useCallback(() => {
    const el = list.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, []);
  useEffect(follow, [follow, state.entries.length, state.partial, state.tools, state.queued.length, state.incoming.length]);
  // On a phone, dragging the conversation left shows when each message was sent.
  const compact = useCompact();
  const track = useRef<HTMLDivElement>(null);
  useSwipeReveal(list, track, compact);

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

  // Something to send: what Send and Enter take, and what brings Send in beside Stop while the agent works.
  const hasMessage = /\S/.test(draft) || attachments.pending.length > 0;
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (attachments.sending || !hasMessage) return;
    const text = draft.trim();
    const named = mentions.take(text);
    const replyTo = replying?.id;
    if (attachments.pending.length === 0) {
      if (!prompt(text, undefined, named, replyTo)) return;
    } else if (!(await attachments.send((inputs) => prompt(text, inputs, named, replyTo)))) return;
    following.current = true;
    setDraft("");
    setReplying(null);
    mentions.clear();
    recalling.reset();
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
  // of the message being replied to. Up and Down bring back earlier messages (history.ts) when the "@" list is not open.
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentions.onKeyDown(event) || recalling.onKeyDown(event)) return;
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

  const sendLabel = attachments.sending ? "Sending…" : "Send";
  const ownerName = people && !isOwner ? people.owner.name : undefined;
  const mine = online.find((presence) => presence.uid === uid)?.windows ?? 0;
  // Where each reply of the agent's starts: after a person's message, its name goes over it.
  const bylines = useMemo(() => agentTurns(state.entries), [state.entries]);
  // Recomputed only when entries change, not as a reply streams.
  const dayStarts = useMemo(() => dayStartsOf(state.entries), [state.entries]);
  const agentLast = useMemo(() => endsInAgentTurn(state.entries), [state.entries]);
  const newAt = useMemo(
    // Only once it is known who owns the chat: until then a member's own legacy messages could not be told apart.
    () => (newSince === undefined || !people ? undefined : firstNew(state.entries, newSince, uid, isOwner)),
    [newSince, state.entries, uid, people, isOwner],
  );
  // The agent's steps in runs, each one line where it starts, ended by what the chat draws over an entry (a day, the
  // "New" line). The streaming reply's first steps join the last run. Both keep what did not change, for Entry's memo.
  const lastRuns = useRef<StepRuns>(undefined);
  const runs = useMemo(() => {
    const breaks = new Set(dayStarts.keys());
    if (newAt !== undefined) breaks.add(newAt);
    return (lastRuns.current = stepRuns(state.entries, breaks, lastRuns.current));
  }, [state.entries, dayStarts, newAt]);
  const lastStreamed = useRef<StreamingSteps>(undefined);
  const streamed = useMemo(
    () => (lastStreamed.current = state.partial && streamingSteps(runs, state.partial, lastStreamed.current)),
    [runs, state.partial],
  );
  useNewInView(list, following, newAt, newSince);
  const hinted = useMemo(() => openHints(hints, state.entries), [hints, state.entries]);
  // A hint comes in after its message: keep it in view for a reader at the bottom.
  useEffect(follow, [follow, hinted]);
  const thinking = state.runStartedAt !== undefined && waitingOnModel(state);
  return (
    <SharedChat.Provider value={shared}>
      <ReactionsContext.Provider value={chatReactions}>
        <section className="chat">
          <header className="chat-header">
            {onMenu && <MenuButton onClick={onMenu} />}
            <h1 className="chat-title" title={title}>
              {title}
            </h1>
            {shared ? (
              <PeopleBar people={shared} online={online} uid={uid} working={state.busy} />
            ) : (
              <span className="chat-people">{mine > 1 && `Open in ${mine} of your windows`}</span>
            )}
            <ChatCost usage={state.usage} entries={state.entries} time={time} />
            {shared && <NotifyButton />}
            {people && <ChatPromptButton chatId={chatId} />}
            {people && (
              <button type="button" ref={shareButton} className="share-button" onClick={() => setSharing(!sharing)} aria-expanded={sharing}>
                {/* The owner shares from here also once people have joined; the people bar beside it shows who is in. */}
                {isOwner ? "Share" : "People"}
              </button>
            )}
          </header>
          {sharing && people && <SharePanel chatId={chatId} uid={uid} isOwner={isOwner} people={people} onLeft={onLeft} onClose={closeSharing} />}
          <StepsProvider entries={state.entries} tools={state.tools} busy={state.busy}>
            <Compact.Provider value={compact}>
              <div className="messages" ref={list} onScroll={onScroll} data-compact={compact || undefined}>
                <div className="transcript" ref={track}>
                  {state.entries.length === 0 && !state.busy && !state.incoming.length && (
                    <div className="empty-chat">
                      <h2>What should we build?</h2>
                      <p>Try: “A live crypto dashboard for BTC, ETH and SOL with 24 h change and a 7-day price chart, refreshing every 30 seconds.”</p>
                    </div>
                  )}
                  {state.entries.map((entry) => {
                    const spend = prompts.get(entry.id);
                    const dayStart = dayStarts.get(entry.id);
                    return (
                      <Fragment key={entry.id}>
                        {dayStart !== undefined && <DaySeparator at={dayStart} />}
                        {entry.id === newAt && <NewDivider />}
                        {bylines.has(entry.id) && <AgentByline />}
                        <Entry
                          entry={entry}
                          steps={streamed?.grown?.entry === entry.id ? streamed.grown.steps : runs.byEntry.get(entry.id as number)}
                          reactions={reactions[entry.id]}
                          uid={uid}
                          ownerName={ownerName}
                          onOpen={onArtifact}
                          onReply={reply}
                          hinted={hinted.has(entry.id as number)}
                          onAskAgent={askAgent}
                          onNoHint={dropHint}
                        />
                        {spend && <PromptCost spend={spend} />}
                      </Fragment>
                    );
                  })}
                  {!agentLast && (state.partial || thinking) && <AgentByline />}
                  {state.partial && <Assistant message={state.partial} steps={streamed?.steps} streaming onGrow={follow} />}
                  {thinking && <Thinking since={state.runStartedAt!} />}
                  {state.error && <div className="chat-error">{state.error}</div>}
                  <Queue queued={state.queued} incoming={state.incoming} uid={uid} />
                </div>
              </div>
            </Compact.Provider>
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
                        ? `Message everyone; ${AGENT_TOKEN} asks ${AGENT_NAME}, and @ names someone, a file or an artifact…`
                        : "Describe a dashboard, or type @ to name a file or artifact…"
                  }
                  rows={1}
                />
                {/* While the agent works Stop is here. Once something is typed or attached, Send joins it: a message for the
                    agent waits its turn in the queue, and stopping needs no clearing of the box. */}
                {working && (
                  // Stop lands where Send was when a run starts, or when sending empties the box and takes Send away:
                  // a double click's second click (detail 2) is not a Stop. It goes once the run ends, so the cursor goes
                  // back to the input, as after Send, rather than to nowhere.
                  <button
                    type="button"
                    className="icon-button composer-stop"
                    disabled={!connected}
                    onClick={(e) => {
                      if (e.detail > 1) return;
                      abort();
                      input.current?.focus();
                    }}
                    title="Stop"
                    aria-label="Stop"
                  >
                    <Icon>
                      <rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none" />
                    </Icon>
                  </button>
                )}
                {(!working || hasMessage) && (
                  <button
                    type="submit"
                    className="icon-button primary"
                    disabled={!connected || attachments.sending || !hasMessage}
                    title={sendLabel}
                    aria-label={sendLabel}
                  >
                    <Icon stroke={2.2}>
                      <path d="M12 19V5M6 11l6-6 6 6" />
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
              <Dictation disabled={!connected} onText={dictated} />
              <ComposerMore
                mentionLabel={shared ? `Ask ${AGENT_NAME}, or name someone, a file or an artifact` : "Name a file or artifact"}
                onMention={mentions.insertAt}
                history={history}
                onRecall={recalling.recall}
                compact={compact}
              />
              {/* The model and the context ring at the right. Stop and the transcript show a run; only an upload needs the spinner. */}
              <div className="composer-model">
                {attachments.sending && <span className="spinner" aria-hidden="true" />}
                <ModelPicker
                  model={state.model}
                  thinkingLevel={state.thinkingLevel}
                  auto={auto}
                  disabled={!connected}
                  attachingImages={attachments.pending.some((item) => item.preview)}
                  onChange={setModel}
                />
                <ContextMeter entries={state.entries} model={state.model} />
              </div>
            </div>
          </form>
        </section>
      </ReactionsContext.Provider>
    </SharedChat.Provider>
  );
}

// Entries never change once committed, so streaming a new reply re-renders only the reply, not the whole history.
const Entry = memo(function Entry({
  entry,
  steps,
  reactions: byEmoji,
  uid,
  ownerName,
  onOpen,
  onReply,
  hinted,
  onAskAgent,
  onNoHint,
}: {
  entry: EntryRecord;
  /** Where an agent message's steps show (stepRuns.ts). */
  steps?: MessageSteps;
  /** Its reactions; the same object until they change, so a reaction draws only its message again. */
  reactions?: EntryReactions;
  uid: string;
  /** Set when someone other than the owner is viewing: a plain `pi.user` entry, from before chats were shared, is the owner's. */
  ownerName?: string;
  onOpen: (artifact: PublishedDetails) => void;
  onReply: (quote: ReplyQuote) => void;
  /** A message of the viewer's that looks meant for the agent: Ask pi under it calls the agent on it (onAskAgent). */
  hinted: boolean;
  onAskAgent: (entry: number) => void;
  onNoHint: (entry: number) => void;
}) {
  const people = useSharedChat();
  const reactions = useMessageReactions(isReactable(entry) ? entry.id : undefined, byEmoji);
  const message = entry.model?.[0];
  // What a reply to it quotes: none for a message from before replies (pi.user).
  const quote = replyQuote(entry);
  const answer = quote ? () => onReply(quote) : undefined;
  if (entry.kind === "pi.user" && message?.role === "user") {
    const author = ownerName === undefined ? undefined : { uid: people?.owner.uid ?? "", name: ownerName };
    return <User text={userText(message)} author={author} uid={uid} sentAt={message.timestamp} />;
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
        sentAt={sentAt(entry)}
        // In the transcript, a message that called the agent was picked up: it was placed in its run.
        picked={data.summoned}
        auto={data.auto}
        tools={data.tools}
        reactions={reactions}
        onReply={answer}
        hint={hinted && <CallHint onAsk={() => onAskAgent(entry.id as number)} onNo={() => onNoHint(entry.id as number)} />}
      />
    );
  }
  if (entry.kind === CHAT_PEOPLE_KIND) {
    const data = entry.data as unknown as ChatPeopleData;
    // A Stop of one agent names it; one of everything names pi, whose run it stopped with the agents' turns.
    const agent = data.agent ? `@${data.agent}` : data.event === "stopped" ? AGENT_NAME : "an agent";
    const [them, you] = PEOPLE_EVENTS[data.event].map((said) => said.replace("{agent}", agent));
    return <div className="chat-notice">{data.uid === uid ? `You ${you}` : `${data.name} ${them}`}</div>;
  }
  if (entry.kind === CHAT_AGENT_KIND) {
    return <AgentReply data={entry.data as unknown as ChatAgentReplyData} reactions={reactions} onReply={answer} onOpen={onOpen} />;
  }
  if (entry.kind === "pi.assistant" && message?.role === "assistant") {
    return <Assistant message={message} steps={steps} reactions={reactions} onReply={answer} />;
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

/** The entries that start a day, the first of each day the conversation has messages on, with their time. */
function dayStartsOf(entries: readonly EntryRecord[]): Map<number, number> {
  const starts = new Map<number, number>();
  let last: number | undefined;
  for (const entry of entries) {
    const at = shown(entry) ? sentAt(entry) : undefined;
    if (at === undefined) continue;
    const day = calendarDay(at);
    if (day !== last) starts.set(entry.id as number, at);
    last = day;
  }
  return starts;
}

/** Over the first message the user has not seen: "New", between two wavy lines. */
function NewDivider() {
  return (
    <div className="new-divider" role="separator" aria-label="New messages">
      New
    </div>
  );
}

/**
 * Once the "New" line is drawn (`newAt`), for each time the user arrives to something new (`since`): scroll the
 * conversation so the end of what they read, the line and the start of what is new show together, with the line about
 * a fifth of the way down. Only when the reader was at the bottom, which opening a chat starts at; one reading higher
 * up stays where they are. Declared after the effect that follows new output, so it runs after it.
 */
function useNewInView(list: RefObject<HTMLDivElement | null>, following: RefObject<boolean>, newAt: number | undefined, since: number | undefined) {
  const shownFor = useRef<number>(undefined);
  useEffect(() => {
    if (newAt === undefined || since === undefined || shownFor.current === since) return;
    const el = list.current;
    const line = el?.querySelector<HTMLElement>(".new-divider");
    if (!el || !line) return;
    shownFor.current = since;
    if (!following.current) return;
    const top = line.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    el.scrollTop = top - Math.min(Math.max(el.clientHeight * 0.2, 48), 160);
    following.current = atBottom(el);
  }, [list, following, newAt, since]);
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

/**
 * Who is in a shared chat: everyone's badge in their colour, with a dot for those who have it open now, then the agent's,
 * marked while it works. Names show on hover (and to screen readers).
 */
function PeopleBar({ people, online, uid, working }: { people: ChatPeople; online: Presence[]; uid: string; working: boolean }) {
  // Each open window is a socket; someone no longer in the chat may still show for a moment, so only people in it count.
  const windows = new Map(online.map((presence) => [presence.uid, presence.windows]));
  const all = everyone(people);
  const here = all.filter((person) => windows.has(person.uid)).length;
  return (
    <div className="people-bar" aria-label={`${all.length} people, ${here} here now`}>
      {all.map((person) => {
        const count = windows.get(person.uid) ?? 0;
        const you = person.uid === uid;
        const state = count === 0 ? "away" : count > 1 ? `here now, in ${count} windows` : "here now";
        return (
          <span key={person.uid} className={count ? "person online" : "person"} title={`${person.name}${you ? " (you)" : ""}: ${state}`}>
            <Avatar name={person.name} tint={tintOf(people, person.uid)} online={count > 0} />
            <span className="sr-only">
              {you ? "You" : person.name}
              {count > 1 && <small> ×{count}</small>}
            </span>
          </span>
        );
      })}
      <span className="people-divider" aria-hidden="true" />
      <span className="person agent" title={`${AGENT_NAME}, the agent: ${working ? "working" : "idle"}`}>
        <AgentAvatar working={working} />
        <span className="sr-only">
          {AGENT_NAME}
          {working && <small> working</small>}
        </span>
      </span>
    </div>
  );
}

/**
 * Each notice as said of someone else, and of the viewer (who may have been removed and invited back). `{agent}` is
 * the agent an owner added or removed, or the one someone stopped.
 */
const PEOPLE_EVENTS: Record<ChatPeopleData["event"], readonly [string, string]> = {
  joined: ["joined the chat", "joined the chat"],
  rejoined: ["joined again from another window or device", "joined again from another window or device"],
  left: ["left the chat", "left the chat"],
  removed: ["was removed from the chat", "were removed from the chat"],
  stopped: ["stopped {agent}", "stopped {agent}"],
  "agent-added": ["added {agent} to the chat", "added {agent} to the chat"],
  "agent-removed": ["removed {agent} from the chat", "removed {agent} from the chat"],
};

/**
 * Messages not in the transcript yet, below everything the agent is doing now, oldest first, faded: those sent while
 * the agent was busy, marked queued, with their place when more than one waits; then those the chat is still getting
 * ready to put in (see IncomingMessage). Each leaves for the queue or the transcript when it goes there.
 */
function Queue({ queued, incoming, uid }: { queued: QueuedMessage[]; incoming: IncomingMessage[]; uid: string }) {
  return (
    <>
      {queued.map((message, i) => (
        <Waiting key={message.id} message={message} uid={uid} label={queued.length > 1 ? `Queued · ${i + 1} of ${queued.length}` : "Queued"} />
      ))}
      {incoming.map((message) => (
        <Waiting key={incomingKey(message)} message={message} uid={uid} label={message.picking ? "Auto · picking a model…" : "Sending…"} incoming />
      ))}
    </>
  );
}

function Waiting({ message, uid, label, incoming = false }: { message: QueuedMessage | IncomingMessage; uid: string; label: string; incoming?: boolean }) {
  const mine = message.uid === uid;
  return (
    <div className={`queued${mine ? " mine" : ""}${incoming ? " incoming" : ""}`}>
      <User
        text={message.text}
        author={mine ? undefined : message}
        uid={uid}
        attachments={message.attachments}
        mentions={"mentions" in message ? message.mentions : undefined}
        replyTo={message.replyTo}
      />
      <small className="queued-label">{label}</small>
    </div>
  );
}

/**
 * A person's message: someone else's on the left under their badge and name, the viewer's own on the right in a bubble,
 * as in a messaging app. Attachments show above the text, and the message it answers above that. In a shared chat each
 * other person's badge has their colour, and a message that called the agent shows, once `picked`, that the agent took it.
 */
function User({
  text,
  author,
  uid,
  attachments = [],
  mentions,
  replyTo,
  picked,
  auto,
  tools,
  sentAt,
  reactions = null,
  onReply,
  hint,
}: {
  text: string;
  /** Undefined for the viewer's own message. */
  author?: Person;
  uid: string;
  /** On an incoming message, only their names and image thumbnails yet. */
  attachments?: (Attachment | IncomingAttachment)[];
  mentions?: Mention[];
  replyTo?: ReplyQuote;
  picked?: boolean;
  /** What Auto picked to answer it, in a chat on Auto. */
  auto?: AutoPick;
  /** Which MCP tools were offered to answer it, when the chat had enough to pick. */
  tools?: ToolPickNote;
  /** When it was sent, shown under it on hover; none in the queue, which says so instead. */
  sentAt?: number;
  reactions?: MessageReactions | null;
  onReply?: () => void;
  /** Under the message: the offer to call the agent on it (CallHint). */
  hint?: ReactNode;
}) {
  const content = useRef<HTMLDivElement>(null);
  const mine = author === undefined;
  const tagsMe = !mine && mentions?.some((mention) => mention.kind === "person" && mention.uid === uid);
  const files = attachments.length > 0 && (
    <div className="attachments">
      {attachments.map((attachment) => (
        <Attached key={attachment.path} attachment={attachment} />
      ))}
    </div>
  );
  const bubble = text && (
    <div className="bubble">
      {replyTo && <ReplyQuoteView quote={replyTo} />}
      <MentionText text={text} mentions={mentions} me={uid} />
    </div>
  );
  return (
    <div ref={content} className={mine ? "message mine" : tagsMe ? "message mentions-me" : "message"}>
      {author ? <Byline author={author} /> : <span className="sr-only">You</span>}
      {bubble && files}
      {/* Over the top corner of the bubble, or of the files when there is no text. */}
      <div className="bubble-row">
        {bubble || files}
        <MessageActions content={content} text={text} reactions={reactions} onReply={onReply} floating />
      </div>
      <ReactionChips reactions={reactions} picked={picked} />
      {auto && <AutoPicked pick={auto} />}
      {tools && <ToolsPicked note={tools} />}
      {hint}
      {sentAt !== undefined && <SentTime at={sentAt} />}
    </div>
  );
}

/**
 * Under a message of the viewer's that did not call the agent but looks meant for it ("pi, can you…"): Ask pi, which
 * replies to it with "@pi", or no.
 */
function CallHint({ onAsk, onNo }: { onAsk: () => void; onNo: () => void }) {
  return (
    <div className="call-hint" role="group" aria-label={`Meant for ${AGENT_NAME}?`}>
      <span>Meant for {AGENT_NAME}?</span>
      <button type="button" className="call-hint-ask" onClick={onAsk} title={`Reply to it with ${AGENT_TOKEN}, so ${AGENT_NAME} answers it`}>
        Ask {AGENT_NAME}
      </button>
      <button type="button" className="call-hint-no" onClick={onNo} title={`Not for ${AGENT_NAME}`} aria-label={`Not for ${AGENT_NAME}`}>
        ×
      </button>
    </div>
  );
}

/** Over someone else's message: their badge in their colour and their name, and in a shared chat whether they own it. */
function Byline({ author }: { author: Person }) {
  const people = useSharedChat();
  return (
    <div className="byline">
      <Avatar name={author.name} tint={people ? tintOf(people, author.uid) : 0} />
      <strong>{author.name}</strong>
      {people && <small>{people.owner.uid === author.uid ? "owner" : "member"}</small>}
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

function Attached({ attachment }: { attachment: Attachment | IncomingAttachment }) {
  const name = baseName(attachment.path);
  const title = "shown" in attachment ? `${attachment.path} · ${formatBytes(attachment.size)} · ${SHOWN[attachment.shown]}` : attachment.path;
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
 * A reply: its text, and its thoughts and tool calls as runs of steps (`steps`), each where it starts. `streaming` while
 * the model writes it, with `onGrow` called as its text is revealed.
 */
function Assistant({
  message,
  steps,
  streaming = false,
  onGrow,
  reactions = null,
  onReply,
}: {
  message: AssistantMessage;
  steps?: MessageSteps;
  streaming?: boolean;
  onGrow?: () => void;
  reactions?: MessageReactions | null;
  onReply?: () => void;
}) {
  const content = useRef<HTMLDivElement>(null);
  // What a copy pastes as plain text: its Markdown. Not while it streams, when it has no actions.
  const text = streaming ? "" : textOf(blocks(message.content), "\n\n");
  const parts = message.content.map((block, i) => {
    if (!block) return null;
    if (block.type === "text")
      return block.text ? (
        <div key={i} className="bubble markdown">
          {streaming ? <RevealedMarkdown text={block.text} onGrow={onGrow} /> : <Markdown text={block.text} />}
        </div>
      ) : null;
    // A step shows in its run, at the run's first step.
    const run = steps?.get(i);
    return run ? <StepRun key={i} items={run} /> : null;
  });
  const ended = endedEarly(message);
  // Nothing of its own to show (its steps are in an earlier message's run): no empty block to space the conversation.
  if (!ended && parts.every((part) => !part)) return null;
  return (
    <div className="assistant" ref={content}>
      {parts}
      {message.stopReason === "error" && <div className="chat-error">The model failed: {message.errorMessage ?? "unknown error"}</div>}
      {message.stopReason === "aborted" && <div className="tool-call">Stopped.</div>}
      {text && (
        <>
          <ReactionChips reactions={reactions} />
          <div className="message-foot">
            <MessageActions content={content} text={text} reactions={reactions} onReply={onReply} />
            <SentTime at={message.timestamp} />
          </div>
        </>
      )}
    </div>
  );
}
