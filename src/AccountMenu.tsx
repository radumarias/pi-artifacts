import { useState } from "react";
import { api } from "./api.ts";
import { DataDialog, type DataMode } from "./DataDialog.tsx";
import { Icon } from "./Icon.tsx";
import { useDismiss } from "./layout.tsx";
import { SystemPromptDialog, SystemPromptIcon } from "./SystemPrompt.tsx";
import { KeyIcon, SignInsDialog } from "./SignIns.tsx";
import { UnreadDot } from "./chat/ChatList.tsx";
import type { McpSignInView } from "../shared/sign-ins.ts";

/**
 * The sidebar footer: who is signed in, with an initial in a circle, as a button that opens a menu above it. The menu
 * holds the user's own system prompt, their sign-ins to servers (when the app has servers each user signs in to), export
 * and import of all their data, and Sign out. A long email ends in an ellipsis; its full text is in the button's tooltip.
 */
export function AccountMenu({
  label,
  onSignOut,
  signIns = [],
  onSignInsChange = () => {},
}: {
  label: string;
  onSignOut: () => void;
  signIns?: McpSignInView[];
  onSignInsChange?: (list: McpSignInView[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [listing, setListing] = useState(false);
  const [data, setData] = useState<DataMode | null>(null);
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
          {signIns.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setListing(true);
              }}
            >
              <KeyIcon />
              Sign-ins
              {signIns.some((item) => item.notice) && <UnreadDot label="A sign-in needs you" />}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setData("export");
            }}
          >
            <Icon size={18}>
              <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
            </Icon>
            Export data
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setData("import");
            }}
          >
            <Icon size={18}>
              <path d="M12 15V3M7 8l5-5 5 5M5 21h14" />
            </Icon>
            Import data
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
      {listing && <SignInsDialog list={signIns} onChange={onSignInsChange} onClose={() => setListing(false)} />}
      {data && <DataDialog mode={data} onClose={() => setData(null)} />}
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
