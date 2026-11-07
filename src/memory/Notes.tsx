import { useEffect, useState, type FormEvent } from "react";
import type { AgentDefinition } from "../../shared/agents.ts";
import {
  dismisses,
  inUse,
  offRecord,
  MAX_NOTE_CHARS,
  scopeLabel,
  waitsForConfirm,
  type MemoryNoteView,
  type MemoryScope,
  type NoteChange,
  type NoteInput,
  type ServerCoverage,
} from "../../shared/memory.ts";
import type { ChatSummary } from "../../shared/protocol.ts";
import { isActive, type SkillInfo } from "../../shared/skills.ts";
import { errorMessage, plural } from "../../shared/util.ts";
import { api, type FileInfo } from "../api.ts";
import { reloadMemory } from "./store.ts";

/** Who a note can be for, as the pickers offer it: just me, one of the user's agents, or one of their own chats. */
export interface NoteTargets {
  agents: readonly Pick<AgentDefinition, "id" | "name">[];
  /** The user's own chats; one off the record keeps no notes, so it is not offered. */
  chats: readonly Pick<ChatSummary, "id" | "title" | "kind" | "sharedBy">[];
}

/** A picker's value for a note's reader: "user", "agent:<id>" or "chat:<id>". */
function targetOf(note: Pick<NoteInput, "scope" | "agentId" | "chatId">): string {
  return note.scope === "user" ? "user" : note.scope === "agent" ? `agent:${note.agentId}` : `chat:${note.chatId}`;
}

function scopeOf(value: string): Pick<NoteInput, "scope" | "agentId" | "chatId"> {
  const [scope, id] = value.split(":") as [MemoryScope, string | undefined];
  return { scope, ...(scope === "agent" && { agentId: id }), ...(scope === "chat" && { chatId: id }) };
}

function TargetPicker({
  value,
  onChange,
  targets,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  targets: NoteTargets;
  label: string;
}) {
  const chats = targets.chats.filter((chat) => !chat.sharedBy && !offRecord([chat.kind]));
  // A note's own chat stays offered when it is not in the list (closed, or the list is still loading).
  const missing = value.startsWith("chat:") && !chats.some((chat) => `chat:${chat.id}` === value);
  return (
    <label>
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="user">Just me: read in my private chats</option>
        {targets.agents.length > 0 && (
          <optgroup label="One agent: wherever it works">
            {targets.agents.map((agent) => (
              <option key={agent.id} value={`agent:${agent.id}`}>
                @{agent.name}
              </option>
            ))}
          </optgroup>
        )}
        {(chats.length > 0 || missing) && (
          <optgroup label="One chat: everyone in it">
            {missing && <option value={value}>This note’s chat</option>}
            {chats.map((chat) => (
              <option key={chat.id} value={`chat:${chat.id}`}>
                {chat.title}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </label>
  );
}

/** Run a change to the notes, then read them again; the error, if any, for the caller to show. */
async function act(action: () => Promise<unknown>): Promise<string | null> {
  try {
    await action();
    return null;
  } catch (error) {
    return errorMessage(error);
  } finally {
    void reloadMemory();
  }
}

/** The form that adds a note, for `initial`'s reader unless the user picks another. */
export function AddNote({ targets, initial, onDone }: { targets: NoteTargets; initial: string; onDone: () => void }) {
  const [text, setText] = useState("");
  const [target, setTarget] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const failed = await act(() => api.addNote({ text, ...scopeOf(target) }));
    setBusy(false);
    setError(failed);
    if (!failed) onDone();
  };
  return (
    <form className="skill-form memory-form" onSubmit={submit}>
      <label>
        Note
        <textarea
          autoFocus
          rows={2}
          maxLength={MAX_NOTE_CHARS}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="e.g. Show amounts in euros, rounded to whole numbers"
        />
      </label>
      <TargetPicker label="Who reads it" value={target} onChange={setTarget} targets={targets} />
      {error && <p className="form-error">{error}</p>}
      <div className="skill-form-actions">
        <button type="submit" className="primary" disabled={busy || !text.trim()}>
          Save note
        </button>
        <button type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Where a note came from, in a few words. */
function sourceText(note: MemoryNoteView): string {
  if (note.source === "person") return "Added by you";
  const by = note.learnedBy ? (note.learnedBy === "pi" ? "pi" : `@${note.learnedBy}`) : "an agent";
  return note.chatTitle && note.scope !== "chat" ? `Learned by ${by} in “${note.chatTitle}”` : `Learned by ${by}`;
}

/** One note: its text, who reads it, where it came from, how often it was read, and what the user can do with it. */
function NoteRow({ note, targets }: { note: MemoryNoteView; targets: NoteTargets }) {
  const [editing, setEditing] = useState<{ text: string; target: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    const failed = await act(action);
    setBusy(false);
    setError(failed);
    return !failed;
  };
  const forgotten = !inUse(note);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    const change: NoteChange = {};
    if (editing.text.trim() !== note.text) change.text = editing.text;
    if (editing.target !== targetOf(note)) Object.assign(change, scopeOf(editing.target));
    if (!Object.keys(change).length || (await run(() => api.changeNote(note.id, change)))) setEditing(null);
  };
  const classes = ["memory-note", forgotten && "forgotten", waitsForConfirm(note) && "unconfirmed"].filter(Boolean).join(" ");
  return (
    <li className={classes}>
      {editing ? (
        <form className="memory-edit" onSubmit={save}>
          <textarea
            autoFocus
            rows={2}
            maxLength={MAX_NOTE_CHARS}
            aria-label="Note"
            value={editing.text}
            onChange={(event) => setEditing({ ...editing, text: event.target.value })}
          />
          <TargetPicker label="Who reads it" value={editing.target} onChange={(target) => setEditing({ ...editing, target })} targets={targets} />
          <div className="skill-form-actions">
            <button type="submit" className="primary" disabled={busy || !editing.text.trim()}>
              Save
            </button>
            <button type="button" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <p className="memory-text">
          {note.pinned && (
            <span className="memory-pin" title="Pinned: always in the prompt" aria-label="Pinned">
              ●
            </span>
          )}
          {note.text}
        </p>
      )}
      <div className="memory-meta">
        <span className="pill">{scopeLabel(note)}</span>
        {waitsForConfirm(note) && <span className="pill review">To confirm</span>}
        {note.kind === "fact" && note.confirmed && <span className="pill">Fact</span>}
        <span>{sourceText(note)}</span>
        <span>{note.uses ? `Read ${plural(note.uses, "time")}` : "Not read yet"}</span>
        {forgotten && <span>Forgotten {new Date(note.forgottenAt!).toLocaleDateString()}</span>}
      </div>
      {!editing && (
        <div className="memory-actions">
          {forgotten ? (
            <>
              <button type="button" disabled={busy} onClick={() => void run(() => api.restoreNote(note.id))}>
                Bring back
              </button>
              <button type="button" className="danger" disabled={busy} onClick={() => void run(() => api.deleteNote(note.id))}>
                Delete
              </button>
            </>
          ) : (
            <>
              {!note.confirmed && (
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => void run(() => api.changeNote(note.id, { confirmed: true }))}
                >
                  Confirm
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                aria-pressed={note.pinned}
                onClick={() => void run(() => api.changeNote(note.id, { pinned: !note.pinned }))}
              >
                {note.pinned ? "Unpin" : "Pin"}
              </button>
              <button type="button" disabled={busy} onClick={() => setEditing({ text: note.text, target: targetOf(note) })}>
                Edit
              </button>
              {note.scope === "chat" && (
                <button
                  type="button"
                  disabled={busy}
                  title="Read in your private chats, not only this one"
                  onClick={() => void run(() => api.changeNote(note.id, { scope: "user" }))}
                >
                  Move to just me
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                title={dismisses(note) ? "Not kept: nothing read it yet" : "Read no more, until you bring it back"}
                onClick={() => void run(() => api.forgetNote(note.id))}
              >
                {dismisses(note) ? "Dismiss" : "Forget"}
              </button>
            </>
          )}
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
    </li>
  );
}

/**
 * Notes as a list, in use first (those to confirm at the top), with the forgotten ones behind "Show forgotten", where
 * each can be brought back. `empty` says what an empty list means.
 */
export function NoteList({ notes, targets, empty }: { notes: readonly MemoryNoteView[]; targets: NoteTargets; empty: string }) {
  const [showForgotten, setShowForgotten] = useState(false);
  const used = notes.filter(inUse).sort((a, b) => Number(a.confirmed) - Number(b.confirmed) || Number(b.pinned) - Number(a.pinned));
  const forgotten = notes.filter((note) => !inUse(note));
  return (
    <>
      {used.length ? (
        <ul className="memory-list">
          {used.map((note) => (
            <NoteRow key={note.id} note={note} targets={targets} />
          ))}
        </ul>
      ) : (
        <p className="skills-note">{empty}</p>
      )}
      {forgotten.length > 0 && (
        <button type="button" className="link-button" aria-expanded={showForgotten} onClick={() => setShowForgotten(!showForgotten)}>
          {showForgotten ? "Hide forgotten" : `Show forgotten (${forgotten.length})`}
        </button>
      )}
      {showForgotten && forgotten.length > 0 && (
        <ul className="memory-list">
          {forgotten.map((note) => (
            <NoteRow key={note.id} note={note} targets={targets} />
          ))}
        </ul>
      )}
    </>
  );
}

/** The user's files and skills, read once for the "what it can reach" sections. */
function useReach(): { files: FileInfo[] | null; skills: SkillInfo[] | null } {
  const [files, setFiles] = useState<FileInfo[] | null>(null);
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  useEffect(() => {
    let live = true;
    api.files().then(
      (list) => live && setFiles(list),
      () => live && setFiles([]),
    );
    api.skills().then(
      (list) => live && setSkills(list),
      () => live && setSkills([]),
    );
    return () => {
      live = false;
    };
  }, []);
  return { files, skills };
}

const SHOWN_FILES = 8;

/**
 * What the agents reach besides their notes: the MCP servers (`servers` narrows them to an agent's), with what each
 * says it covers as a chat last listed it; the user's files; and the skills that are on.
 */
export function Reach({ coverage, servers, who }: { coverage: readonly ServerCoverage[]; servers?: readonly string[]; who: string }) {
  const { files, skills } = useReach();
  const shown = servers ? coverage.filter((server) => servers.includes(server.name)) : coverage;
  const on = (skills ?? []).filter(isActive);
  return (
    <section className="memory-reach" aria-label="What it can reach">
      <h3>Connected data</h3>
      {shown.length ? (
        <ul className="skill-list">
          {shown.map((server) => (
            <li key={server.name} className="skill">
              <strong>{server.name}</strong>
              {server.about && <p>{server.about}</p>}
              <p className="skills-note">
                {plural(server.tools, "tool")}
                {server.some.length > 0 && `: ${server.some.join(", ")}${server.tools > server.some.length ? ", …" : ""}`}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="skills-note">
          {servers && !servers.length ? `${who} uses no MCP server.` : "No server listed yet: they show here once a chat has used them."}
        </p>
      )}
      <h3>Documents</h3>
      {files === null ? (
        <p className="skills-note">Loading…</p>
      ) : files.length ? (
        <>
          <p className="skills-note">
            {who} can read your {plural(files.length, "file")} when you ask, in the chats you own.
          </p>
          <ul className="memory-files">
            {files.slice(0, SHOWN_FILES).map((file) => (
              <li key={file.path}>{file.path}</li>
            ))}
            {files.length > SHOWN_FILES && <li className="skills-note">and {files.length - SHOWN_FILES} more, under Files</li>}
          </ul>
        </>
      ) : (
        <p className="skills-note">No files yet.</p>
      )}
      <h3>Skills</h3>
      {skills === null ? (
        <p className="skills-note">Loading…</p>
      ) : on.length ? (
        <p className="memory-skills">
          {on.map((skill) => (
            <span key={`${skill.origin}:${skill.name}`} className="pill" title={skill.description}>
              {skill.name}
            </span>
          ))}
        </p>
      ) : (
        <p className="skills-note">No skill is on.</p>
      )}
    </section>
  );
}
