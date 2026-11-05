import { useState } from "react";
import { api } from "./api.ts";
import { Icon } from "./Icon.tsx";
import { useDismiss } from "./layout.tsx";
import { SystemPromptDialog, SystemPromptIcon } from "./SystemPrompt.tsx";

/**
 * The sidebar footer: who is signed in, with an initial in a circle, as a button that opens a menu above it. The menu
 * holds the user's own system prompt and Sign out. A long email ends in an ellipsis; its full text is in the button's tooltip.
 */
export function AccountMenu({ label, onSignOut }: { label: string; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const box = useDismiss<HTMLElement>(open, setOpen);
  return (
    <footer className="account" ref={box}>
      <button
        type="button"
        className="account-button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={open ? "account-menu" : undefined}
        title={label}
      >
        <span className="avatar" aria-hidden="true">
          {(label.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase()}
        </span>
        <span className="account-name">{label}</span>
        <Icon size={14} box={16}>
          <path d="M4 6l4 4 4-4" />
        </Icon>
      </button>
      {/* After the button, so Tab moves from it into the menu; CSS places the menu above it. */}
      {open && (
        <div className="account-menu" id="account-menu">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setEditing(true);
            }}
          >
            <SystemPromptIcon />
            System prompt
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
          >
            <Icon size={18}>
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
            </Icon>
            Sign out
          </button>
        </div>
      )}
      {editing && (
        <SystemPromptDialog
          title="System prompt"
          about="Added to the agent's built-in instructions in all your chats, including the ones you share. Each chat can add its own."
          load={api.systemPrompt}
          save={api.setSystemPrompt}
          onClose={() => setEditing(false)}
        />
      )}
    </footer>
  );
}
