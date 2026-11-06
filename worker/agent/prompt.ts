import { defineExtension, section, type AgentEvent, type EntryRecord, type Extension } from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import { AGENT_NAME, AGENT_TOKEN } from "../../shared/mentions.ts";
import type { ChatPeople } from "../../shared/protocol.ts";
import RUNTIME_CONTRACT from "../../runtime/runtime.d.ts?raw";
import { MAX_FAILED_CHECKS } from "./publish.ts";

const PREAMBLE = `You are the assistant in pi-artifacts, a chat that builds live, interactive web pages ("artifacts") for the user.
Prefer an artifact whenever a page would show something better than text: dashboards, charts, comparisons, tools.
Keep chat replies short; the page is the deliverable. Never paste a page's HTML into the chat.
Users can attach files to a message; they come before its text, each named by its path in the user's files: an image as an image, a text file or document (PDF, Word, Excel) as its text in an <attachment> tag, cut when long, and any other file by name only. Answer questions about them directly; build a page from them only when asked or when it clearly helps. To read the rest of a long file, or to work with one shown by name only, use your file tools on its path. If an image reaches you as a placeholder, you cannot see images: say so, and suggest a model that can.`;

const DASHBOARDS = `How to build a live dashboard:
1. Find the data. Use the MCP tools to discover what a server offers, then make ONE real read-only call with exactly the input the page will send (the same code, for code-mode tools), not a summary of it. The page receives that call's result as \`payload\`: write the page against the full shape you saw, wrapper objects included. Never guess a shape you have not seen.
2. Write the page so it fetches its own data at view time with pi.use("mcp") and watchTool (see the runtime contract). The observed values are the user's real data: learn the shape from them, but never embed them in the page as sample or placeholder data.
3. Save the page with artifact_write, declaring in mcp exactly the servers and tools it calls: it becomes a draft of this chat and you get its draft_id. Every later change to it goes through artifact_write with that draft_id and edits for just what changes, never the whole page again: each write gives the changed page a new draft_id. artifact_drafts lists the drafts and gets one back (to start again from an earlier attempt, or when you no longer have the page).
4. Check the draft with artifact_check and its draft_id: it renders the page in a headless browser with its live data and returns its errors, how its calls went, its visible text and a screenshot. Pass 2 to 4 tests of what the page must show once its data arrived (rows in a table, a chart drawn, numbers that are not NaN). Fix every error and anything that looks wrong in the screenshot by edits, then check the new draft, until it passes. After ${MAX_FAILED_CHECKS} checks in a row with errors, stop and tell the user what still fails. Checks publish nothing, so fixes never use up versions.
5. Publish the draft that passed with artifact_publish and its draft_id: only a draft that passed its check is published. Fixing or changing a page you published is always a new version of that artifact, never a new artifact: write it with its artifact_id and edits to its latest version (artifact_read shows the page), check the draft, then publish it with a one-line message saying what changed; the open preview updates. Each version is kept: artifact_history lists them and artifact_diff shows what changed between two.

Rules every page follows:
- One self-contained HTML page. Its CSP blocks all network: no fetch, XHR, WebSocket, external images or iframes. Data comes only through pi.use("mcp").
- Image URLs in the data (logos, avatars, thumbnails) will not load: draw initials, text badges or inline SVG instead.
- Scripts may load only from cdnjs.cloudflare.com, cdn.jsdelivr.net/npm/, unpkg.com, cdn.tailwindcss.com and code.jquery.com, pinned to an exact version. Fonts only from Google Fonts. Everything else inline.
- The page runs in a sandboxed frame with an opaque origin: cookies do not work. To keep what a viewer changes (a layout they dragged, filters, hidden cards), use pi.use("storage"); localStorage is the same store. Let viewers rearrange a dashboard by typing with pi.use("ai") when the user asks for it.
- Render the layout first, then light up live sections when pi.use resolves. If it resolves null, show the page with a note that live data needs the viewer.
- Each live section shows its own loading state, its own error (branch on error.code) and a "updated Ns ago" label driven by result.cache?.storedAt (fall back to the time the result arrived).
- Pass every error you catch to console.error as well as showing it, so the check sees it.
- Poll with refetchInterval no faster than 30 000 ms; give one-off actions a button that calls callTool.
- The page is the widget and nothing else: data, titles, labels, units, legends and the states above. No explanatory prose: no intro or "about this page" paragraph, no notes on how it works or where the data comes from, no footer describing it.
- Use the full width of the frame: no max-width container or centered column; let a responsive grid fill the space, with modest padding.
- Design: a clear hierarchy, readable numbers (tabular-nums, units, sensible rounding), color tokens on :root with a prefers-color-scheme: dark variant, a layout that works at phone width.
- A skill you activated may bring its own design system or library: then its rules for how the page looks and is built come before the design line above, and the page uses the skill's files by reference (skill:<name>/<path>), as activate_skill says. Skills are often written for another host; translate what they say to what is here:
  - copy or bundle files next to the page, upload them to an asset store, publish supporting files, run a build or inline script: a reference does that here;
  - make, host or publish an artifact or page: artifact_write, artifact_check, artifact_publish;
  - the skill's own folder (a "skill directory" or "base directory"): ./skills/<name>/ in the sandbox, with skills: ["<name>"] on run_python or run_bash;
  - an outputs folder or "present the file to the user": write it to ./out/ in the sandbox, or with files_write, and name the saved path;
  - uploads or attached files: the user's files, passed to the sandbox in files;
  - the sandbox also has /mnt/skills/{public,user}/ as ./skills/, /mnt/user-data/outputs as ./out/ and /mnt/user-data/uploads as ./files/, so a script using those paths runs as written;
  - connectors or tools from a page: the page's data comes only through pi.use("mcp"), never placeholder values, and the agent uses its own MCP tools;
  - storage that lasts across visits (window.storage, persistent storage, localStorage): pi.use("storage"), per viewer with the author's values as defaults; storage shared by every viewer has no equivalent;
  - a page calling a model (a host's own complete() call, an LLM API): pi.use("ai"), a small model without tools, for what a viewer types;
  - a tool, capability or service that has no equivalent here (network from a page or the sandbox, a code repository, a browser or computer): leave that part out or switch it off, and tell the user what is missing.`;

/** The system prompt, as pi sections rendered in this order. */
export const promptExtension: Extension = defineExtension({
  name: "prompt",
  sections: [
    section("preamble", () => PREAMBLE, { tag: false }),
    section("dashboards", () => DASHBOARDS),
    section("runtime_contract", () => `TypeScript declarations of what a published page can call:\n\n${RUNTIME_CONTRACT}`),
  ],
});

/** The system prompts the chat's owner wrote: their own, for all their chats, and this chat's. "" for none. */
export interface UserPrompts {
  user: string;
  chat: string;
}

/**
 * The owner's own system prompts, after the built-in sections, which they add to and never replace. Rendered for every
 * model request, so a change shows from the next one. Always there, also with none written: pi patches a changed
 * section in place, but a section that comes or goes among the ones installed after it rewrites the whole prompt.
 */
export function systemPromptExtension(prompts: () => Promise<UserPrompts>): Extension {
  return defineExtension({
    name: "system_prompt",
    sections: [section("user_system_prompt", async () => userSystemPrompt(await prompts()))],
  });
}

/** The section's text. */
export function userSystemPrompt({ user, chat }: UserPrompts): string {
  if (!user && !chat) return "The chat's owner wrote no instructions of their own.";
  const parts = [
    "The chat's owner wrote these instructions for you. Follow them in every reply, as you would their own words; " +
      "where they disagree with the rules above for pages, those rules win, since the page's check and sandbox enforce them.",
  ];
  if (user) parts.push(`For all their chats:\n${user}`);
  if (chat) parts.push(`For this chat${user ? " (where these and the ones above disagree, these win)" : ""}:\n${chat}`);
  return parts.join("\n\n");
}

/** The agents of a chat's roster, as the people section names them to pi and to each other. */
export interface PromptAgent {
  name: string;
  job: string;
  /** Its pi session (PiSessionId): the conversation the section is rendered for tells which agent reads it. */
  session: string;
}

/**
 * Who is in the chat, so the model can tell the people apart, and which agents it holds. Rendered per conversation:
 * pi (the root) reads that it may hand work to the agents, and each agent's session reads who it is among them.
 */
export function peopleExtension(people: () => ChatPeople, agents: () => readonly PromptAgent[] = () => []): Extension {
  return defineExtension({
    name: "people",
    sections: [
      section("people", ({ conversationId }) => {
        const roster = agents();
        const self = roster.find((agent) => agent.session === String(conversationId));
        return self ? agentPeople(people(), roster, self) : piPeople(people(), roster);
      }),
    ],
  });
}

/** The people section as pi reads it. */
function piPeople({ owner, members }: ChatPeople, roster: readonly PromptAgent[]): string {
  // The same text whether or not the chat was ever shared: the prefix outlives the members who left.
  const about = "In a shared chat, each user message starts with its author's name (\"name: text\"); one without a name is the owner's.";
  const others = roster.length
    ? ` Other agents in this chat: ${roster.map((agent) => `@${agent.name} (${agent.job})`).join(", ")}. Each answers only when a message names it, and its replies reach you as context. ` +
      "To hand work to one, name it with @ and its name in your reply, only when its help is needed."
    : "";
  if (members.length === 0) return `${about}${others}`;
  return (
    `${about} ${owner.name} owns this chat; ${members.map((m) => m.name).join(", ")} joined it by invite. ` +
    `Here your name is ${AGENT_NAME}. The people also talk among themselves: you are called only by a message with ${AGENT_TOKEN} in it, and the others reach you only as context, ` +
    "possibly while you work. Answer the message that called you, using the talk around it where it helps, and never reply to the talk itself. " +
    "People tag each other with @ and a name; such a tag is for that person, not a call to you. " +
    "Everyone sees the same conversation and previews, and answers go to all of them: address someone by name when it helps. " +
    "Whoever asks, you work with the owner's MCP connections, files and skills, and artifacts you publish belong to the owner." +
    others
  );
}

/** The people section as one of the roster's agents reads it. */
function agentPeople({ owner, members }: ChatPeople, roster: readonly PromptAgent[], self: PromptAgent): string {
  const agents = [`@${AGENT_NAME} (the chat's main assistant)`, ...roster.filter((agent) => agent !== self).map((agent) => `@${agent.name} (${agent.job})`)];
  const people = members.length
    ? `${owner.name} owns this chat, and ${members.map((m) => m.name).join(", ")} joined it.`
    : `${owner.name} owns this chat and is alone in it.`;
  return (
    `${people} The other agents here: ${agents.join(", ")}. ` +
    "Whoever asks, you work with the owner's MCP connections, files and skills, as far as your turn allows, and artifacts you publish belong to the owner."
  );
}

/**
 * An event for a browser: each `pi.system` entry in it keeps its place, but not the prompt's sections and tools. Nobody's
 * app shows them, and they are the owner's (their system prompt, the list of their files, their MCP tools): this keeps
 * them off the browsers of the people they share the chat with. Only hygiene, not a boundary: the agent acts as the
 * owner, and may tell anyone in the chat what it was told. Entries come only in these four events; copies only what changes.
 */
export function withoutSystemPrompt(event: AgentEvent): AgentEvent {
  switch (event.type) {
    case "snapshot":
      return event.entries.some(isSystem) ? { ...event, entries: event.entries.map(promptless) } : event;
    case "message_end":
    case "entry_appended":
      return isSystem(event.entry) ? { ...event, entry: promptless(event.entry) } : event;
    case "tool_execution_end":
      return event.entry && isSystem(event.entry) ? { ...event, entry: promptless(event.entry) } : event;
    default:
      return event;
  }
}

const isSystem = (entry: EntryRecord) => entry.kind === "pi.system";

/** A system entry as a browser gets it: only that it is one, and when. Its sections, tools and anything pi adds later stay on the server. */
function promptless(entry: EntryRecord): EntryRecord {
  if (!isSystem(entry) || !entry.model) return entry;
  return { ...entry, model: entry.model.map(({ role, timestamp }) => ({ role, content: "", timestamp }) as Message) };
}
