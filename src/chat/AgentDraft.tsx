import { useState } from "react";
import type { AgentDraftView } from "../../shared/agents.ts";
import { errorMessage } from "../../shared/util.ts";
import { api } from "../api.ts";
import { Markdown } from "./Markdown.tsx";
import { AgentByline } from "./people.tsx";

/**
 * A reply of one of the viewer's agents held for them to review before the chat sees it (reviewBeforePosting): it was
 * built on servers they do not share with the chat. Only they see it, with which servers it read, and Post to chat,
 * Edit (then post what they wrote) or Discard. `onDone` gets the drafts left, as the chat answered.
 */
export function AgentDraft({ chatId, draft, onDone }: { chatId: string; draft: AgentDraftView; onDone: (drafts: AgentDraftView[]) => void }) {
  const { reply } = draft;
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const act = async (action: "post" | "discard") => {
    setBusy(true);
    setError(undefined);
    try {
      onDone(await api.reviewAgentDraft(chatId, draft, action, action === "post" && editing !== null ? editing : undefined));
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <div className="agent-reply agent-draft" aria-label={`Draft reply of @${reply.name}, only you can see it`}>
      <AgentByline name={reply.name} badge={reply} note="agent · draft" />
      <div className="draft-note">
        Only you can see this draft · {reply.name} used {reply.sources?.join(", ") || "private servers"} · private
      </div>
      {editing === null ? (
        <div className="bubble markdown">
          <Markdown text={reply.text} />
        </div>
      ) : (
        <textarea
          className="draft-edit"
          value={editing}
          onChange={(event) => setEditing(event.target.value)}
          aria-label="Edit the reply before posting it"
          rows={4}
          autoFocus
        />
      )}
      <div className="draft-actions">
        <button type="button" className="primary" onClick={() => act("post")} disabled={busy || (editing !== null && !editing.trim())}>
          Post to chat
        </button>
        {editing === null ? (
          <button type="button" onClick={() => setEditing(reply.text)} disabled={busy}>
            Edit
          </button>
        ) : (
          <button type="button" onClick={() => setEditing(null)} disabled={busy}>
            Cancel edit
          </button>
        )}
        <button type="button" className="danger" onClick={() => act("discard")} disabled={busy}>
          Discard
        </button>
      </div>
      {error && <div className="chat-error">{error}</div>}
    </div>
  );
}
