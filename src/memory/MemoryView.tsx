import { useState } from "react";
import { waitsForConfirm } from "../../shared/memory.ts";
import type { ChatSummary } from "../../shared/protocol.ts";
import { useAgents } from "../agents/store.ts";
import { MenuButton } from "../layout.tsx";
import { AddNote, NoteList, Reach, type NoteTargets } from "./Notes.tsx";
import { toConfirm, useMemory } from "./store.ts";

type Filter = "all" | "confirm" | "user" | "agent" | "chat";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "confirm", label: "To confirm" },
  { id: "user", label: "Just me" },
  { id: "agent", label: "Agents" },
  { id: "chat", label: "Chats" },
];

/**
 * What the user's agents know: their memory notes, which the user can add, edit, pin, move, confirm, forget and bring
 * back; and what else agents reach (connected data, documents, skills).
 */
export function MemoryView({ chats, onMenu }: { chats: readonly ChatSummary[]; onMenu?: () => void }) {
  const { notes, coverage, error } = useMemory();
  const { agents } = useAgents();
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const targets: NoteTargets = { agents: agents ?? [], chats };
  const waiting = toConfirm(notes);
  const shown = (notes ?? []).filter((note) => (filter === "all" ? true : filter === "confirm" ? waitsForConfirm(note) : note.scope === filter));
  return (
    <div className="skills memory">
      <header className="skills-head">
        <div>
          {onMenu && <MenuButton onClick={onMenu} />}
          <h2>Memory</h2>
          <p>
            What your agents keep between conversations. Notes just for you are read only in your private chats; an agent’s notes wherever it works; a
            chat’s only in that chat. Nothing is kept from a chat off the record, and a fact an agent learns waits for you to confirm it.
          </p>
        </div>
        <div className="skills-actions">
          <button type="button" className="primary" onClick={() => setAdding(true)} disabled={adding}>
            + Add a note
          </button>
        </div>
      </header>
      {adding && <AddNote targets={targets} initial="user" onDone={() => setAdding(false)} />}
      {error && <p className="form-error">Could not read your notes: {error}</p>}
      <nav className="memory-filters" aria-label="Show">
        {FILTERS.map((each) => (
          <button
            key={each.id}
            type="button"
            className={each.id === filter ? "chip active" : "chip"}
            aria-pressed={each.id === filter}
            onClick={() => setFilter(each.id)}
          >
            {each.label}
            {each.id === "confirm" && waiting > 0 && ` (${waiting})`}
          </button>
        ))}
      </nav>
      {notes === null ? (
        <p className="skills-note">Loading your notes…</p>
      ) : (
        <NoteList
          notes={shown}
          targets={targets}
          empty={
            filter === "all" ? "No notes yet. Agents save one when you tell them how you want things, or you can add one here." : "No notes here."
          }
        />
      )}
      <Reach coverage={coverage} who="Your agents" />
    </div>
  );
}
