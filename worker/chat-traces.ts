import type { EntryRecord } from "@earendil-works/pi-durable";
import { CHAT_MESSAGE_KIND, PUBLISH_TOOL, type ChatMessageData, type PublishedDetails, type SavedFilesDetails } from "../shared/protocol.ts";

/** What a chat left outside its own object, as its transcript records it: the artifacts it published and the files it attached or saved. */
export interface ChatTraces {
  artifacts: Set<string>;
  files: Set<string>;
}

const SANDBOX_TOOLS = new Set(["run_python", "run_bash"]);

/**
 * The artifacts and files `entries` (a chat's whole history, oldest first or not) name: files attached to people's
 * messages, and those the agent's tools say they saved. Tool results carry what they saved in their details; results
 * from before they did are read from their text, which those tools write in a fixed shape.
 */
export function chatTraces(entries: Iterable<EntryRecord>): ChatTraces {
  const traces: ChatTraces = { artifacts: new Set(), files: new Set() };
  for (const entry of entries) {
    if (entry.kind === CHAT_MESSAGE_KIND) {
      for (const attachment of (entry.data as unknown as ChatMessageData | undefined)?.attachments ?? []) traces.files.add(attachment.path);
    }
    for (const message of entry.model ?? []) {
      if (message.role !== "toolResult") continue;
      const details = message.details as Partial<PublishedDetails & SavedFilesDetails> | undefined;
      if (message.toolName === PUBLISH_TOOL && typeof details?.artifactId === "string") traces.artifacts.add(details.artifactId);
      const saved = Array.isArray(details?.saved) ? details.saved : savedInText(message.toolName, textOf(message.content));
      for (const path of saved) if (typeof path === "string") traces.files.add(path);
    }
  }
  return traces;
}

function textOf(content: readonly { type: string; text?: string }[]): string {
  return content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

/**
 * The files an older tool result says it saved. files_write's text starts "Wrote <path> (", and a sandbox run's ends
 * with "saved: <paths>" (and "not saved: …"): only that end is read, since the script's own output comes before it.
 * Sandbox runs save only under out/.
 */
function savedInText(tool: string, text: string): string[] {
  if (tool === "files_write") {
    const path = text.match(/^Wrote (.+) \(\d+ characters\)\.$/)?.[1];
    return path ? [path] : [];
  }
  if (!SANDBOX_TOOLS.has(tool)) return [];
  const list = text.match(/\n\nsaved: ([^\n]+)(?:\n\nnot saved: [^\n]*)?$/)?.[1];
  return list ? list.split(", ").filter((path) => path.startsWith("out/")) : [];
}
