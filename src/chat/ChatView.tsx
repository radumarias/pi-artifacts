import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { assistantOffer } from "../../shared/offers.ts";
import { CHAT_AGENT_KIND, proposedBy, type ChatAgentReplyData, type ChatAgentView } from "../../shared/agents.ts";
import { DraftCard } from "../agents/DraftCard.tsx";
import type { ItemRef } from "../../shared/items.ts";
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
import { AgentAvatar, AgentByline, Avatar, ChatAgents, SharedChat, tintOf, tintStyle, toneStyle, useChatAgents, useSharedChat } from "./people.tsx";
import { MenuButton } from "../layout.tsx";
import { AutoPicked, ToolsPicked } from "./AutoPick.tsx";
import { ChatCost, PromptCost } from "./Cost.tsx";
import { ContextMeter } from "./Context.tsx";
import { ChatPromptButton } from "../SystemPrompt.tsx";
import { SharePanel } from "./SharePanel.tsx";
import { promptSpend, totalTime } from "./spend.ts";
import { shownLive, useChat, waitingOnModel, type AgentLive } from "./useChat.ts";
import { PeopleBar, Since } from "./AgentsBar.tsx";
import { queueLines } from "./agentLines.ts";
import { Fold, FoldScope, ItemChips } from "./Fold.tsx";
import { workingPhrase } from "./phrase.ts";
import { ComposerMore } from "./ComposerMore.tsx";
import { Dictation } from "./Dictation.tsx";
import { ownMessages, useHistory } from "./history.ts";
import { AgentReply } from "./AgentReply.tsx";
import { ActionCard, ChatActions } from "./ActionCard.tsx";
import { CHAT_ACTION_KIND, type ChatActionData } from "../../shared/limits.ts";
import { ChecklistCard } from "./ChecklistCard.tsx";
import { CHAT_CHECKLIST_KIND, checklistAt, foldChecklists, type ChatChecklistData } from "../../shared/checklist.ts";
import { ArtifactCard } from "./ArtifactCard.tsx";
import { Markdown } from "./Markdown.tsx";
import { MentionList, MentionText, useMentions } from "./Mentions.tsx";
import { NotifyButton } from "./notify.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { OrphanResult, StepRun, StepsProvider, stepLabel } from "./Steps.tsx";
import { endedEarly, stepRuns, streamingSteps, type MessageSteps, type StepRuns, type StreamingSteps } from "./stepRuns.ts";
import { Thinking } from "./Thinking.tsx";
import { useRevealedText } from "./reveal.ts";
import { blocks, firstNew, inReply, isAgent, liveOffer, openHints, published, replyItems, sentAt, shown, showsAsCard, userText } from "./entries.ts";
import { OfferRow } from "./Offer.tsx";
import {
  answersEveryMessage,
  CHAT_BUDGET_KIND,
  CHAT_COPY_KIND,
  CHAT_EVENT_KIND,
  legacyKind,
  type ChatBudgetData,
  type ChatCopyData,
  type ChatEventData,
} from "../../shared/chat-kinds.ts";
import { BranchOff, ChatEventNotice, EntryOf, KindChip, TagCard } from "./ChatKinds.tsx";

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
  /** Go to another chat: a branch, or the chat a branch came from. */
  onOpenChat?: (chatId: string) => void;
}

const GROWS_ITSELF = CSS.supports("field-sizing", "content");

/** Whether the conversation is scrolled to (near) its end, where new output is followed. */
const atBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < 80;

export function ChatView({ chatId, title, uid, newSince, onArtifact, onActivity, onLeft, onMenu, onOpenChat }: Props) {
  const { state, connected, people, online, prompt, takeOffer: sendYes, abort, setModel, auto, reactions, react, hints, dropHint, agents, agentSettings, live, actions } =
    useChat(chatId);
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
  // A chat with other people or other agents: every message shows its author's badge, and the people bar lists them.
  const group = shared ?? (people && agents.length > 0 ? people : null);
  const isOwner = people?.owner.uid === uid;
  // The people the viewer shares other chats with, whom "@" offers to add (TagCard).
  const [known, setKnown] = useState<Person[]>([]);
  useEffect(() => void api.people().then(setKnown, () => {}), []);
  // Agents answer only messages that call them, unless the chat is private.
  const callsOnly = !answersEveryMessage(people?.kind ?? legacyKind(shared !== null));
  const around = useMemo(() => ({ known, canInvite: isOwner, inChat: people ? everyone(people) : [], callsOnly }), [known, isOwner, people, callsOnly]);
  const mentions = useMentions(chatId, draft, setDraft, input, shared, uid, agents, around);
  // The viewer's own earlier messages, to bring back into the composer (Up, or the "more" menu). Who owns the chat must be
  // known first: a plain `pi.user` entry is the owner's.
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
  // The latest next step a reply offered (shared/offers.ts), which only the chat's owner answers: Yes replies to that
  // message, which calls the agent that wrote it, asking it to set the step up.
  const offered = useMemo(() => (isOwner ? liveOffer(state.entries) : undefined), [isOwner, state.entries]);
  const takeOffer = useCallback(
    (entry: number) => {
      if (!sendYes(entry)) return false;
      following.current = true;
      return true;
    },
    [sendYes],
  );
  // Branch off a new chat from a message, and go to it.
  // One branch at a time: a second click while one is made does nothing.
  const branching = useRef(false);
  const branchOff = useCallback(
    (entry: number) => {
      if (branching.current) return;
      branching.current = true;
      api
        .branch(chatId, entry)
        .then(
          (made) => onOpenChat?.(made.chatId),
          (error) => alert(`Could not branch off: ${errorMessage(error)}`),
        )
        .finally(() => (branching.current = false));
    },
    [chatId, onOpenChat],
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
  useEffect(follow, [follow, state.entries.length, state.partial, state.tools, state.queued.length, state.incoming.length, live]);
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

  // "Make an agent" in the composer's menu: the ask starts the message, and the viewer says what the agent is for. pi
  // drafts it (agent_propose), and its card shows here.
  const makeAgent = useCallback(() => {
    const start = `${shared ? `${AGENT_TOKEN} ` : ""}Make me an agent that `;
    setDraft((current) => (current.trim() ? `${start}${current.trim()}` : start));
    requestAnimationFrame(() => {
      const el = input.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    });
  }, [shared]);

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
  const phrase = useMemo(() => (thinking ? workingPhrase(state.entries, state.partial, stepLabel) : undefined), [thinking, state.entries, state.partial]);
  // pi's replies' item chips: the records its tool results held, under the reply built on them.
  const itemsBefore = useRef<ReadonlyMap<number, ItemRef[]>>(undefined);
  const items = useMemo(() => (itemsBefore.current = replyItems(state.entries, itemsBefore.current)), [state.entries]);
  // Each plan an agent posted, as its latest entry says, drawn where it was first posted: only that entry draws again.
  const checklists = useMemo(() => foldChecklists(state.entries), [state.entries]);
  // The agents working now, each with its live steps, its time and its own Stop; then who waits for a turn.
  const liveTurns = useMemo(() => shownLive(live, agents, state.entries), [live, agents, state.entries]);
  const waiting = useMemo(() => queueLines(agents), [agents]);
  // The held calls' cards: their live state, and whether the viewer decides them.
  const chatActions = useMemo(() => ({ actions, isOwner, ownerName: people?.owner.name }), [actions, isOwner, people]);
  return (
    <ChatActions.Provider value={chatActions}>
    <SharedChat.Provider value={group}>
      <ChatAgents.Provider value={agents}>
        <FoldScope.Provider value={chatId}>
        <BranchOff.Provider value={onOpenChat ? branchOff : null}>
        <ReactionsContext.Provider value={chatReactions}>
          <section className="chat">
            <header className="chat-header">
              {onMenu && <MenuButton onClick={onMenu} />}
              <h1 className="chat-title" title={title}>
                {title}
              </h1>
              {people?.kind && <KindChip chatId={chatId} kind={people.kind} page={people.page} isOwner={isOwner} />}
              {!group && <span className="chat-people">{mine > 1 && `Open in ${mine} of your windows`}</span>}
              {people && (group || isOwner) && (
                <PeopleBar chatId={chatId} people={people} online={online} uid={uid} piWorking={state.busy} agents={agents} live={live} settings={agentSettings} bar={group !== null} />
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
                          {/* A message's actions branch off from it (BranchOff). */}
                          <EntryOf.Provider value={entry.id as number}>
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
                              onOffer={entry.id === offered ? takeOffer : undefined}
                              onNoHint={dropHint}
                              onOpenChat={onOpenChat}
                              chatId={chatId}
                              items={items.get(entry.id as number)}
                              checklist={checklistAt(checklists, entry)}
                            />
                          </EntryOf.Provider>
                          {spend && <PromptCost spend={spend} />}
                        </Fragment>
                      );
                    })}
                    {!agentLast && (state.partial || thinking) && <AgentByline />}
                    {state.partial && <Assistant message={state.partial} steps={streamed?.steps} streaming onGrow={follow} />}
                    {thinking && <Thinking since={state.runStartedAt!} phrase={phrase} />}
                    {state.error && <div className="chat-error">{state.error}</div>}
                    {liveTurns.map((turn) => (
                      <AgentTurnLive
                        key={`${turn.agent.id}:${turn.turn}`}
                        live={turn}
                        onStop={connected ? () => abort(turn.agent.id) : undefined}
                        onGrow={follow}
                      />
                    ))}
                    {waiting.map((line) => (
                      <div key={line.agentId} className="agent-queue-line">
                        {line.text}
                      </div>
                    ))}
                    <Queue queued={state.queued} incoming={state.incoming} uid={uid} />
                  </div>
                </div>
              </Compact.Provider>
            </StepsProvider>
            <form className="composer" onSubmit={submit} onDragOver={onDragOver} onDrop={onDrop}>
              {attachments.error && <div className="chat-error">{attachments.error}</div>}
              <MentionList mentions={mentions} uid={uid} />
              {mentions.outsider && (
                <TagCard
                  key={mentions.outsider.name}
                  person={mentions.outsider}
                  isOwner={isOwner}
                  onNotNow={mentions.dismissOutsider}
                  onAdd={async () => {
                    const outsider = mentions.outsider;
                    if (outsider && "uid" in outsider) await api.addMember(chatId, outsider.uid);
                    mentions.dismissOutsider();
                  }}
                  onNewChat={async () => {
                    const outsider = mentions.outsider;
                    if (!outsider || !("uid" in outsider)) return;
                    const made = await api.createChat();
                    await api.addMember(made.id, outsider.uid);
                    mentions.dismissOutsider();
                    onOpenChat?.(made.id);
                  }}
                  onInvite={async () => (await api.createInvite(chatId)).url}
                />
              )}
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
                        : callsOnly
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
                  onMakeAgent={makeAgent}
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
        </BranchOff.Provider>
        </FoldScope.Provider>
      </ChatAgents.Provider>
    </SharedChat.Provider>
    </ChatActions.Provider>
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
  onOpenChat,
  chatId,
  items,
  checklist,
  onOffer,
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
  onOpenChat?: (chatId: string) => void;
  /** The chat it is in: where an agent pi drafted is brought when its owner turns it on from its card. */
  chatId: string;
  /** For one of pi's replies: the records its tool results held, as chips under it. */
  items?: ItemRef[];
  /** For the entry a checklist was first posted at: its latest state (the same object until it changes). */
  checklist?: ChatChecklistData;
  /** Set on the reply with the chat's latest offer, for its owner: Yes under it replies to it (false when not sent). */
  onOffer?: (entry: number) => boolean;
}) {
  const people = useSharedChat();
  const offerYes = onOffer && (() => onOffer(entry.id as number));
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
    const [them, you] = PEOPLE_EVENTS[data.event].map((said) => said.replace("{agent}", agent).replace("{by}", data.by ?? "the owner"));
    return <div className="chat-notice">{data.uid === uid ? `You ${you}` : `${data.name} ${them}`}</div>;
  }
  if (entry.kind === CHAT_BUDGET_KIND) return <div className="chat-notice budget-notice">{(entry.data as unknown as ChatBudgetData).text}</div>;
  if (entry.kind === CHAT_EVENT_KIND) return <ChatEventNotice data={entry.data as unknown as ChatEventData} uid={uid} onOpenChat={onOpenChat} />;
  if (entry.kind === CHAT_COPY_KIND) {
    const data = entry.data as unknown as ChatCopyData;
    if (data.from === "artifact") return <ArtifactCard artifact={{ artifactId: data.artifactId, title: data.title, version: data.version }} onOpen={onOpen} />;
    const copied = { role: "assistant", content: [{ type: "text", text: data.text }], timestamp: data.sentAt ?? 0, stopReason: "stop" } as unknown as AssistantMessage;
    return <Assistant message={copied} reactions={reactions} onReply={answer} />;
  }
  // A checklist's later entries draw nothing: its card, where it was first posted, shows what they say.
  if (entry.kind === CHAT_CHECKLIST_KIND) return checklist ? <ChecklistCard data={checklist} /> : null;
  if (entry.kind === CHAT_AGENT_KIND) {
    return (
      <AgentReply
        data={entry.data as unknown as ChatAgentReplyData}
        chatId={chatId}
        viewerUid={uid}
        reactions={reactions}
        onReply={answer}
        onOpen={onOpen}
        entry={entry.id as number}
        onOfferYes={offerYes}
      />
    );
  }
  if (entry.kind === CHAT_ACTION_KIND) return <ActionCard action={(entry.data as unknown as ChatActionData).action} />;
  if (entry.kind === "pi.assistant" && message?.role === "assistant") {
    return (
      <Assistant
        message={message}
        steps={steps}
        reactions={reactions}
        onReply={answer}
        items={items}
        foldKey={String(entry.id)}
        entry={entry.id as number}
        onOfferYes={offerYes}
      />
    );
  }
  if (entry.kind === "pi.tool-result" && message?.role === "toolResult") {
    const artifact = published(entry);
    if (artifact) return <ArtifactCard artifact={artifact} onOpen={onOpen} />;
    const drafted = proposedBy(entry);
    // Only the owner has the draft: pi saves it in their directory. A chat nobody else is in is the viewer's own.
    if (drafted) return <DraftCard details={drafted} chatId={chatId} mine={!people || people.owner.uid === uid} />;
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

/**
 * The agent's entries that start one of its replies: the first of its own after anything else the chat shows. Its own
 * plan, and a plan's later entries, which draw nothing, do not end a reply (inReply).
 */
function agentTurns(entries: readonly EntryRecord[]): Set<number> {
  const starts = new Set<number>();
  const posted = new Set<string>();
  let inTurn = false;
  for (const entry of entries) {
    if (!shown(entry) || inReply(entry, posted)) continue;
    if (isAgent(entry) && !inTurn) starts.add(entry.id as number);
    inTurn = isAgent(entry);
  }
  return starts;
}

function endsInAgentTurn(entries: readonly EntryRecord[]): boolean {
  const posted = new Set<string>();
  let last: EntryRecord | undefined;
  for (const entry of entries) if (shown(entry) && !inReply(entry, posted)) last = entry;
  return last !== undefined && isAgent(last);
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
  added: ["was added by {by}", "were added by {by}"],
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

/**
 * The message a reply answers: who wrote it, in their colour (an agent of the chat's in its own, as "@name"), and the
 * start of it.
 */
function ReplyQuoteView({ quote }: { quote: ReplyQuote }) {
  const people = useSharedChat();
  const agents = useChatAgents();
  if ("agent" in quote) {
    const agent = quote.agentId === undefined ? undefined : agents.find((view) => view.id === quote.agentId);
    return (
      <div className={quote.agentId ? "reply-quote agent toned" : "reply-quote agent"} style={agent && toneStyle(agent.color)}>
        <strong>{quote.agentId ? `@${quote.name}` : quote.name}</strong> <span>{quote.text}</span>
      </div>
    );
  }
  return (
    <div className="reply-quote" style={people ? tintStyle(tintOf(people, quote.uid)) : undefined}>
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
  items,
  foldKey,
  bare = false,
  entry,
  onOfferYes,
}: {
  message: AssistantMessage;
  steps?: MessageSteps;
  streaming?: boolean;
  onGrow?: () => void;
  reactions?: MessageReactions | null;
  onReply?: () => void;
  /** The records its tool results held, as chips under it. */
  items?: readonly ItemRef[];
  /** Names it for its "Show more": a long text folds once it is in the transcript, never while it streams. */
  foldKey?: string;
  /** Without reactions, actions and its time: a live agent's message, whose reply the chat shows once it is posted. */
  bare?: boolean;
  /** Its entry in the transcript, which the answer to its offered next step is remembered by. */
  entry?: number;
  /** On the chat's latest offer, for its owner: what Yes does (OfferRow). */
  onOfferYes?: () => boolean;
}) {
  const content = useRef<HTMLDivElement>(null);
  // What a copy pastes as plain text: its Markdown. Not while it streams, when it has no actions.
  const text = streaming ? "" : textOf(blocks(message.content), "\n\n");
  // The next step its answer offers, shown under it without its line in the text; not before the answer is whole.
  const offered = streaming || bare ? null : assistantOffer(message.content);
  const parts = message.content.map((block, i) => {
    if (!block) return null;
    if (block.type === "text") {
      const said = offered?.block === i ? offered.body : block.text;
      // The fold goes round the bubble, so a copy (the bubbles' HTML) holds neither "Show more" nor the fold's height.
      return said ? (
        !streaming && foldKey ? (
          <Fold key={i} foldKey={`${foldKey}:${i}`}>
            <div className="bubble markdown">
              <Markdown text={said} />
            </div>
          </Fold>
        ) : (
          <div key={i} className="bubble markdown">
            {streaming ? <RevealedMarkdown text={said} onGrow={onGrow} /> : <Markdown text={said} />}
          </div>
        )
      ) : null;
    }
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
      {items && <ItemChips items={items} />}
      {offered && <OfferRow offer={offered.offer} entry={entry} onYes={onOfferYes} />}
      {text && !bare && (
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

/** No breaks: an agent's live turn draws no day or "New" line between its steps. */
const NO_BREAKS: ReadonlySet<number> = new Set();

/**
 * An agent working on a turn, under the conversation, as pi's run shows: a working line with its badge, how long it has
 * worked and its step's short phrase, and its own Stop (`onStop`, absent while not connected); then its steps and text
 * as they come, from its own session. Once its reply is posted the reply shows instead (shownLive).
 */
function AgentTurnLive({ live, onStop, onGrow }: { live: AgentLive & { agent: ChatAgentView }; onStop?: () => void; onGrow?: () => void }) {
  const { agent, state, startedAt, endedAt, ended } = live;
  const running = endedAt === undefined;
  const runs = useMemo(() => stepRuns(state.entries, NO_BREAKS), [state.entries]);
  const streamed = useMemo(() => state.partial && streamingSteps(runs, state.partial), [runs, state.partial]);
  const phrase = workingPhrase(state.entries, state.partial, stepLabel);
  return (
    <div className="agent-live" aria-live="off">
      <div className="byline agent working-line">
        <AgentAvatar badge={agent} working={running} />
        <strong>@{agent.name}</strong>
        <small className="working-what">
          {running ? "working" : ended === "stopped" ? "stopped" : "posting its reply"}
          {startedAt !== undefined && running && (
            <>
              {" · "}
              <Since at={startedAt} />
            </>
          )}
          {phrase && ` · ${phrase}`}
        </small>
        {running && onStop && (
          <button type="button" className="working-stop" onClick={onStop} title={`Stop @${agent.name} only`}>
            Stop
          </button>
        )}
      </div>
      <StepsProvider entries={state.entries} tools={state.tools} busy={running}>
        {state.entries.map((entry) => {
          const message = entry.model?.[0];
          if (entry.kind === "pi.assistant" && message?.role === "assistant") {
            const steps = streamed?.grown?.entry === entry.id ? streamed.grown.steps : runs.byEntry.get(entry.id as number);
            return <Assistant key={entry.id} message={message} steps={steps} bare />;
          }
          if (entry.kind === "pi.tool-result" && message?.role === "toolResult" && !showsAsCard(entry)) return <OrphanResult key={entry.id} message={message} />;
          return null;
        })}
        {state.partial && <Assistant message={state.partial} steps={streamed?.steps} streaming onGrow={onGrow} bare />}
      </StepsProvider>
    </div>
  );
}

