// What a chat's model calls cost, counted where they are made (the chat object): every call of pi's, its agents' and
// their runs' goes through one wrapper of the chat's Models. It counts each answer's tokens and dollars for the day
// (UTC), stops calls once the chat's daily token budget is used up (an answer that fails at once, which ends the turn
// with the budget's notice), and tags each request for AI Gateway's logs with who it was for: the owner, the chat, and
// the agent and run (AI Gateway custom metadata, which its logs filter by and its cost view groups by).

import { createAssistantMessageEventStream, type AssistantMessage, type Models, type Usage } from "@earendil-works/pi-ai";
import { defineExtension, GenerationTask, hook, ProviderDoc, type Extension } from "@earendil-works/pi-durable";
import { calculateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { budgetDay, budgetNotice } from "../../shared/agent-settings.ts";
import { NO_USAGE } from "../agent/route.ts";
import { tapStream } from "../streams.ts";
import type { Kv } from "../chat-kind.ts";

/** What one day of a chat's model calls came to. */
export interface DaySpend {
  tokens: number;
  costUsd: number;
}

/** Who a request was for, as AI Gateway's metadata says it. Scalars only: the gateway refuses nested values, and takes five keys. */
export interface SpendTags {
  /** "pi", or the agent's id. */
  agent: string;
  /** A run's agent and due time: "<agentId>:<dueAt>". */
  run?: string;
}

/** What one answer cost, as the meter tells its listener: for the owner's daily meter and the metrics. */
export interface Spent {
  tokens: number;
  costUsd: number;
  tags: SpendTags;
  /** The tool calls the answer made. */
  toolCalls: number;
  /** The pi session it was for, when the meter knows it. */
  conversation?: string;
}

const SPEND_KEY = "spend:";
/** Days kept: a few, for the settings panel's "today" and a look back; older ones go when a new day starts. */
const KEPT_DAYS = 3;
const DAY_MS = 86_400_000;
/** Sessions tagged at once: enough for a chat's agents and its runs' items, without growing for ever. */
const MAX_TAGGED = 500;

/**
 * One chat's meter (see the file's head). The day's totals are in the chat object's KV, so a restart keeps them. The
 * sessions' tags come from the generation hook (meterExtension), which knows which session a request is for, keyed by
 * the provider session id pi-durable sends with each request of that session.
 */
export class ChatSpend {
  readonly #kv: Kv;
  readonly #now: () => number;
  readonly #base: { uid: string; chat: string };
  readonly #budget: () => number | undefined;
  readonly #spent: (spent: Spent) => void;
  /** Provider session id → the pi session (conversation) it is for. */
  readonly #sessions = new Map<string, string>();
  /** Conversation → its tags (an agent's session, a run's item). */
  readonly #tags = new Map<string, SpendTags>();

  constructor(options: {
    kv: Kv;
    uid: string;
    chatId: string;
    /** The chat's daily token budget, as its settings say now; undefined for none. */
    budget: () => number | undefined;
    /** Told of every answer, after it is counted. Must not throw. */
    spent?: (spent: Spent) => void;
    now?: () => number;
  }) {
    this.#kv = options.kv;
    this.#now = options.now ?? Date.now;
    this.#base = { uid: options.uid, chat: options.chatId };
    this.#budget = options.budget;
    this.#spent = options.spent ?? (() => {});
  }

  /** What the chat's calls came to today (UTC). */
  today(): DaySpend {
    return this.#kv.get<DaySpend>(`${SPEND_KEY}${budgetDay(this.#now())}`) ?? { tokens: 0, costUsd: 0 };
  }

  /** The notice a call stopped by the budget answers with; undefined while there is room. */
  refusal(): string | undefined {
    const budget = this.#budget();
    return budget !== undefined && this.today().tokens >= budget ? budgetNotice(budget) : undefined;
  }

  /**
   * Count what a turn another object ran for the chat came to (a member's agent's, in its seat): in the chat's day, which
   * its budget stops at, but not as an answer of this object's (its owner's object pays for it and counts it there).
   */
  count(spent: DaySpend): void {
    this.#add(Math.max(0, spent.tokens), Math.max(0, spent.costUsd));
  }

  /** Add to the chat's day (UTC); a new day lets the oldest go (#prune). */
  #add(tokens: number, costUsd: number): void {
    if (!tokens && !costUsd) return;
    const day = budgetDay(this.#now());
    const key = `${SPEND_KEY}${day}`;
    const before = this.#kv.get<DaySpend>(key);
    if (!before) this.#prune(day);
    this.#kv.put(key, { tokens: (before?.tokens ?? 0) + tokens, costUsd: (before?.costUsd ?? 0) + costUsd } satisfies DaySpend);
  }

  /** Tag the requests of a pi session (an agent's, a run item's); pi's own are "pi". */
  tag(conversation: string, tags: SpendTags): void {
    this.#tags.delete(conversation);
    this.#tags.set(conversation, tags);
    if (this.#tags.size > MAX_TAGGED) this.#tags.delete(this.#tags.keys().next().value!);
  }

  /** The generation hook saw a request of `conversation`, sent with `providerSession` (pi-durable's ProviderDoc). */
  requested(conversation: string, providerSession: string | undefined): void {
    if (!providerSession) return;
    this.#sessions.delete(providerSession);
    this.#sessions.set(providerSession, conversation);
    if (this.#sessions.size > MAX_TAGGED) this.#sessions.delete(this.#sessions.keys().next().value!);
  }

  /** Count one answer's usage (and its tool calls), for the session it was for when known. */
  record(usage: Usage, conversation?: string, toolCalls = 0): void {
    const tokens = calculateContextTokens(usage);
    const costUsd = usage.cost.total;
    if (!tokens && !costUsd) return;
    this.#add(tokens, costUsd);
    try {
      this.#spent({ tokens, costUsd, toolCalls, tags: this.#tagsOf(conversation), ...(conversation && { conversation }) });
    } catch (error) {
      console.error("spend:", error);
    }
  }

  #tagsOf(conversation: string | undefined): SpendTags {
    return (conversation && this.#tags.get(conversation)) || { agent: "pi" };
  }

  /** AI Gateway's metadata for a request sent with `providerSession`. */
  metadata(providerSession: string | undefined): Record<string, string> {
    const conversation = providerSession ? this.#sessions.get(providerSession) : undefined;
    const tags = this.#tagsOf(conversation);
    return { uid: this.#base.uid, chat: this.#base.chat, agent: tags.agent, ...(tags.run && { run: tags.run }) };
  }

  /** Drop the days before the KEPT_DAYS newest, as a new day starts. */
  #prune(day: string): void {
    const start = Date.parse(`${day}T00:00:00Z`);
    // A week back is far enough: a chat quiet for longer had its last day pruned when it was the new one.
    for (let back = KEPT_DAYS; back < KEPT_DAYS + 7; back++) this.#kv.delete(`${SPEND_KEY}${budgetDay(start - back * DAY_MS)}`);
  }

  /**
   * `models`, metered: each request is tagged (metadata) and counted when its answer ends; once the budget is used up,
   * a request is not sent, and answers at once with an error that ends the turn with the budget's notice.
   */
  models(models: Models): Models {
    const streamSimple = models.streamSimple.bind(models);
    // completeSimple (the calls that summarize a long conversation) goes through streamSimple too.
    models.streamSimple = (model, context, options) => {
      const refused = this.refusal();
      if (refused) return refusedStream(model, refused);
      const providerSession = options?.sessionId;
      const conversation = providerSession ? this.#sessions.get(providerSession) : undefined;
      const metadata = { ...options?.metadata, ...this.metadata(providerSession) };
      const stream = streamSimple(model, context, { ...options, metadata });
      let counted = false;
      const count = (message: AssistantMessage) => {
        if (counted) return;
        counted = true;
        this.record(message.usage, conversation, message.content.filter((block) => block?.type === "toolCall").length);
      };
      return tapStream(
        stream,
        (event) => {
          if (event.type === "done") count(event.message);
          else if (event.type === "error") count(event.error);
        },
        count,
      );
    };
    return models;
  }
}

/** An answer that fails at once with `reason`, as a provider's error would: the turn ends with it. */
function refusedStream(model: { api: string; provider: string; id: string }, reason: string) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api as AssistantMessage["api"],
    provider: model.provider as AssistantMessage["provider"],
    model: model.id,
    usage: structuredClone(NO_USAGE),
    stopReason: "error",
    errorMessage: reason,
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: "error", reason: "error", error: message });
    stream.end(message);
  });
  return stream;
}

/**
 * The generation hook that tells the meter which pi session each request is for: before each request, the session's
 * provider session id, which the request carries to the models (and so to ChatSpend.models).
 */
export function meterExtension(meter: Pick<ChatSpend, "requested">): Extension {
  return defineExtension({
    name: "meter",
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async (_request, api, context) => {
          const provider = await api.snapshot(ProviderDoc, api.conversationId, context);
          meter.requested(String(api.conversationId), provider?.sessionId);
          return undefined;
        },
      }),
    ],
  });
}
