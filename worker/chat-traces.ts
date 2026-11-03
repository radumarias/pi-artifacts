import type { EntryRecord } from "@earendil-works/pi-durable";
import { firstText } from "../shared/canonical.ts";
import { CHAT_MESSAGE_KIND, PUBLISH_TOOL, type ChatMessageData, type PublishedDetails, type SavedFilesDetails } from "../shared/protocol.ts";

/** The agent's tools that write the user's files (worker/agent/tools.ts), and how their results say what they saved. */
export const FILES_WRITE_TOOL = "files_write";
export const RUN_PYTHON_TOOL = "run_python";
export const RUN_BASH_TOOL = "run_bash";
/** The folder of the user's files that chats save their outputs under, each in its own (see chatOutFolder). */
const SANDBOX_OUT = "out/";

/**
 * This chat's folder in the user's files: where its sandbox runs save what they wrote to ./out, so two chats of one
 * user running at once never overwrite each other's outputs. The agent is asked to keep files it writes there too.
 */
export function chatOutFolder(chatId: string): string {
  return `${SANDBOX_OUT}${chatId}/`;
}

export function wroteReport(path: string, characters: number): string {
  return `Wrote ${path} (${characters} characters).`;
}

/** A sandbox report's last parts: what it saved, then what it could not. Nothing of the script's own output comes after them. */
export function savedReport(saved: readonly string[], skipped: readonly string[]): string[] {
  return [saved.length ? `saved: ${saved.join(", ")}` : "", skipped.length ? `not saved: ${skipped.join("; ")}` : ""];
}

/** What a chat left outside its own object, as its transcript records it: the artifacts it published and the files it attached or saved. */
export interface ChatTraces {
  artifacts: Set<string>;
  files: Set<string>;
}

/**
 * Add the artifacts and files `entries` (some or all of a chat's history) name to `traces`: files attached to people's
 * messages, and those the agent's tools say they saved. Tool results carry what they saved in their details; results
 * from before they did are read from their text (see wroteReport and savedReport).
 */
export function chatTraces(entries: Iterable<EntryRecord>, traces: ChatTraces = { artifacts: new Set(), files: new Set() }): ChatTraces {
  for (const entry of entries) {
    if (entry.kind === CHAT_MESSAGE_KIND) {
      for (const attachment of (entry.data as unknown as ChatMessageData | undefined)?.attachments ?? []) traces.files.add(attachment.path);
    }
    for (const message of entry.model ?? []) {
      if (message.role !== "toolResult") continue;
      const details = message.details as Partial<PublishedDetails & SavedFilesDetails> | undefined;
      if (message.toolName === PUBLISH_TOOL && typeof details?.artifactId === "string") traces.artifacts.add(details.artifactId);
      const saved = Array.isArray(details?.saved) ? details.saved : savedInText(message.toolName, firstText(message.content) ?? "");
      for (const path of saved) if (typeof path === "string") traces.files.add(path);
    }
  }
  return traces;
}

/** The files an older result says it saved. Of a sandbox run's report only the end is read: the script's output comes before it. */
function savedInText(tool: string, text: string): string[] {
  if (tool === FILES_WRITE_TOOL) {
    const path = text.match(/^Wrote (.+) \(\d+ characters\)\.$/)?.[1];
    return path ? [path] : [];
  }
  if (tool !== RUN_PYTHON_TOOL && tool !== RUN_BASH_TOOL) return [];
  const list = text.match(/\n\nsaved: ([^\n]+)(?:\n\nnot saved: [^\n]*)?$/)?.[1];
  return list ? list.split(", ").filter((path) => path.startsWith(SANDBOX_OUT)) : [];
}
