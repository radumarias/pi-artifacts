import { useState } from "react";
import type { AgentTabProps } from "../agents/AgentPage.tsx";
import { useAgents } from "../agents/store.ts";
import { AddNote, NoteList, Reach, type NoteTargets } from "./Notes.tsx";
import { useMemory } from "./store.ts";

/**
 * What one agent knows: the notes it reads (its own, and the user's own in private chats), those it learned in chats,
 * and what it reaches (its servers, the user's files, the skills). Only for the user's own agent: someone else's,
 * shared in a chat, keeps its notes with its owner.
 */
export function KnowsTab({ subject }: AgentTabProps) {
  const { notes, coverage, error } = useMemory();
  const { agents } = useAgents();
  const [adding, setAdding] = useState(false);
  if (subject.kind !== "own") {
    return (
      <p className="skills-note">
        {subject.kind === "new" ? "Save the agent first: then you can give it notes." : "What this agent knows stays with its owner."}
      </p>
    );
  }
  const { agent } = subject;
  const targets: NoteTargets = { agents: agents ?? [], chats: [] };
  // Its own notes and those it learned in chats, and the user's own, which it reads in private chats.
  const known = (notes ?? []).filter((note) => note.agentId === agent.id || note.scope === "user");
  return (
    <div className="memory knows">
      <div className="knows-head">
        <p className="skills-note">
          @{agent.name} reads its own notes wherever it works, and yours (Just me) in your private chats. What it learns in a shared chat stays with
          that chat.
        </p>
        <button type="button" onClick={() => setAdding(true)} disabled={adding}>
          + Add a note
        </button>
      </div>
      {adding && <AddNote targets={targets} initial={`agent:${agent.id}`} onDone={() => setAdding(false)} />}
      {error && <p className="form-error">Could not read the notes: {error}</p>}
      {notes === null ? (
        <p className="skills-note">Loading…</p>
      ) : (
        <NoteList notes={known} targets={targets} empty={`@${agent.name} has no notes yet.`} />
      )}
      <Reach coverage={coverage} servers={agent.servers} who={`@${agent.name}`} />
    </div>
  );
}
