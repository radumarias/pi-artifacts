import { useEffect, useRef, useState } from "react";
import { MAX_SYSTEM_PROMPT, type ChatSystemPrompt } from "../shared/system-prompt.ts";
import { errorMessage } from "../shared/util.ts";
import { api } from "./api.ts";
import { Icon } from "./Icon.tsx";

interface Props {
  title: string;
  /** What the prompt applies to, under the title. */
  about: string;
  load: () => Promise<ChatSystemPrompt>;
  save: (text: string) => Promise<ChatSystemPrompt>;
  onClose: () => void;
  onSaved?: (saved: ChatSystemPrompt) => void;
}

/**
 * A system prompt to read and, for whoever may, change: the user's own (from the account menu) or a chat's (from its
 * header). Escape and Cancel close it without saving; not while it saves.
 */
export function SystemPromptDialog({ title, about, load, save, onClose, onSaved }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [loaded, setLoaded] = useState<ChatSystemPrompt | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dialog.current?.showModal();
    load().then(
      (prompt) => {
        setLoaded(prompt);
        setDraft(prompt.text);
      },
      (e) => setError(errorMessage(e)),
    );
    // Loaded once, when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await save(draft);
      onSaved?.(saved);
      dialog.current?.close();
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  };

  const editable = loaded?.editable === true;
  const over = draft.trim().length > MAX_SYSTEM_PROMPT;
  return (
    <dialog ref={dialog} className="confirm-dialog prompt-dialog" onClose={onClose} onCancel={(e) => saving && e.preventDefault()}>
      <h2>{title}</h2>
      <p className="prompt-about">{about}</p>
      {loaded ? (
        editable ? (
          <>
            <textarea
              aria-label={title}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={saving}
              rows={10}
              placeholder="For example: Answer in British English. Keep pages in a dark theme with large numbers."
              autoFocus
            />
            <small className={over ? "form-error" : undefined}>
              {draft.trim().length.toLocaleString()} / {MAX_SYSTEM_PROMPT.toLocaleString()} characters
            </small>
          </>
        ) : (
          <div className="prompt-text">{loaded.text || "None set."}</div>
        )
      ) : (
        !error && <p>Loading…</p>
      )}
      {error && <p className="form-error">{error}</p>}
      <div className="confirm-actions">
        <button type="button" disabled={saving} onClick={() => dialog.current?.close()}>
          {editable ? "Cancel" : "Close"}
        </button>
        {editable && (
          <button type="button" className="primary" disabled={saving || over || draft.trim() === loaded.text} onClick={() => void submit()}>
            {saving ? "Saving…" : "Save"}
          </button>
        )}
      </div>
    </dialog>
  );
}

/** The icon for a system prompt: lines of text with a pen. */
export function SystemPromptIcon({ size = 18 }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M4 6h12M4 11h9M4 16h5M14.5 19.5l.6-2.6 5.2-5.2a1.4 1.4 0 0 1 2 2l-5.2 5.2z" />
    </Icon>
  );
}

/**
 * In a chat's header: the chat's own system prompt, which adds to its owner's. Whoever may change it (the owner) always
 * sees the button; anyone else only when the chat has one, to read. Highlighted while one is set.
 */
export function ChatPromptButton({ chatId }: { chatId: string }) {
  const [prompt, setPrompt] = useState<ChatSystemPrompt | null>(null);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let current = true;
    setPrompt(null);
    api.chatSystemPrompt(chatId).then(
      (loaded) => current && setPrompt(loaded),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [chatId]);
  if (!prompt || (!prompt.editable && !prompt.text)) return null;
  const label = prompt.editable ? "This chat's system prompt" : "This chat's system prompt (read only)";
  return (
    <>
      <button
        type="button"
        ref={button}
        className={`icon-button chat-prompt-button${prompt.text ? " set" : ""}`}
        onClick={() => setOpen(true)}
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
      >
        <SystemPromptIcon />
      </button>
      {open && (
        <SystemPromptDialog
          title="This chat's system prompt"
          about={
            prompt.editable
              ? "Added after your own system prompt, for this chat only. Everyone you share the chat with can read it."
              : "The chat's owner set this for the agent here. Only they can change it."
          }
          // Read again: the owner may have changed it in another window since.
          load={() => api.chatSystemPrompt(chatId)}
          save={(text) => api.setChatSystemPrompt(chatId, text)}
          onSaved={setPrompt}
          onClose={() => {
            setOpen(false);
            button.current?.focus();
          }}
        />
      )}
    </>
  );
}
