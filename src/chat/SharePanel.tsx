import { useCallback, useEffect, useState } from "react";
import type { ChatPeople, ChatPeopleView, CreatedInvite } from "../../shared/protocol.ts";
import { errorMessage } from "../../shared/util.ts";
import { api } from "../api.ts";

interface Props {
  chatId: string;
  uid: string;
  /** Who is in the chat, live from its socket: reloads the panel when someone joins or leaves. */
  people: ChatPeople | null;
  onLeft: () => void;
}

/** The chat's people. Its owner invites by link and removes members; a member can leave. */
export function SharePanel({ chatId, uid, people, onLeft }: Props) {
  const [view, setView] = useState<ChatPeopleView | null>(null);
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isOwner = (people ?? view)?.owner.uid === uid;

  const load = useCallback(() => void api.people(chatId).then(setView, (e) => setError(errorMessage(e))), [chatId]);
  useEffect(load, [load, people]);

  const act = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const invite = () => act(async () => setCreated(await api.createInvite(chatId)));
  const leave = () => {
    if (!confirm("Leave this chat? You need a new invite to come back.")) return;
    void act(async () => {
      await api.removeMember(chatId, uid);
      onLeft();
    });
  };

  return (
    <div className="share-panel">
      <ul>
        {view && (
          <li>
            {view.owner.name} <small>owner{view.owner.uid === uid && " · you"}</small>
          </li>
        )}
        {view?.members.map((member) => (
          <li key={member.uid}>
            {member.name} {member.uid === uid && <small>you</small>}
            {isOwner && (
              <button type="button" onClick={() => void act(() => api.removeMember(chatId, member.uid))}>
                Remove
              </button>
            )}
          </li>
        ))}
        {view?.invites?.map((open) => (
          <li key={open.id}>
            <small>Invite link, open until {new Date(open.expiresAt).toLocaleString()}</small>
            <button type="button" onClick={() => void act(() => api.revokeInvite(chatId, open.id))}>
              Revoke
            </button>
          </li>
        ))}
      </ul>
      {isOwner ? (
        <>
          <p className="share-warning">
            People you invite chat with this chat's agent, which works as you: with your MCP connections and sign-ins, your files and your skills.
            They can ask it to read or change anything those reach.
          </p>
          <button type="button" className="primary" onClick={() => void invite()}>
            Create an invite link
          </button>
          {created && (
            <div className="invite-link">
              <input readOnly value={created.url} onFocus={(e) => e.target.select()} />
              <button type="button" onClick={() => void navigator.clipboard.writeText(created.url)}>
                Copy
              </button>
              <small>Works once, for 7 days. Only shown now.</small>
            </div>
          )}
        </>
      ) : (
        <button type="button" onClick={leave}>
          Leave this chat
        </button>
      )}
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}
