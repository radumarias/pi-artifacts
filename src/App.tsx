import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import type { ChatSummary, PublishedDetails } from "../shared/protocol.ts";
import { isActive, type SkillInfo } from "../shared/skills.ts";
import { errorMessage } from "../shared/util.ts";
import { api, type ArtifactSummary, type FileInfo, type Me } from "./api.ts";
import { ArtifactPanel } from "./artifact/ArtifactPanel.tsx";
import { ChatView } from "./chat/ChatView.tsx";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { ResizeHandle, useStoredState } from "./layout.tsx";
import { SkillsView } from "./skills/SkillsView.tsx";

function usePath(): [string, (path: string) => void] {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((next: string) => {
    if (next !== location.pathname) history.pushState(null, "", next);
    setPath(next);
  }, []);
  return [path, navigate];
}

export function App() {
  const [path, navigate] = usePath();
  // Who is signed in, and how this deployment signs people in. Undefined until the Worker answers.
  const [session, setSession] = useState<{ me: Me | null; auth: Me["auth"] }>();

  useEffect(() => {
    api.me().then(setSession, () => setSession({ me: null, auth: "access" }));
  }, []);

  if (!session) return null;
  const { me } = session;
  // Deployed, Cloudflare Access signs people in before the app loads; a 401 here means the session lapsed.
  if (me === null && session.auth === "access") return <AccessExpired />;
  if (me === null) return <SignIn onSignedIn={(uid) => setSession({ me: { uid, auth: "demo" }, auth: "demo" })} />;

  const shared = path.match(/^\/a\/([a-z0-9]+)$/);
  if (shared) {
    // A shared artifact: anyone the app lets in can view it by its link.
    return (
      <ErrorBoundary what="this artifact">
        <ArtifactPanel artifactId={shared[1]} uid={me.uid} fullPage />
      </ErrorBoundary>
    );
  }

  const chatId = path.match(/^\/c\/([a-z0-9]+)$/)?.[1];
  return (
    <Workspace
      uid={me.uid}
      label={me.email ?? me.uid}
      chatId={chatId}
      showSkills={path === "/skills"}
      navigate={navigate}
      onSignOut={async () => {
        if (me.auth === "access") {
          location.href = "/cdn-cgi/access/logout";
          return;
        }
        await api.signOut();
        setSession({ me: null, auth: me.auth });
        navigate("/");
      }}
    />
  );
}

function AccessExpired() {
  return (
    <main className="sign-in">
      <div>
        <h1>pi-artifacts</h1>
        <p>Your sign-in has expired.</p>
        <button type="button" className="primary" onClick={() => location.reload()}>
          Sign in again
        </button>
      </div>
    </main>
  );
}

function SignIn({ onSignedIn }: { onSignedIn: (uid: string) => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      onSignedIn((await api.signIn(name)).uid);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <main className="sign-in">
      <form onSubmit={submit}>
        <h1>pi-artifacts</h1>
        <p>Chat with a Pi agent that builds live dashboards from MCP data.</p>
        <label>
          Your name
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. ada" />
        </label>
        <button type="submit" disabled={!name.trim()}>
          Continue
        </button>
        {error && <p className="form-error">{error}</p>}
        <p>Demo sign-in: no password, so anyone who types the same name sees the same chats.</p>
      </form>
    </main>
  );
}

interface WorkspaceProps {
  uid: string;
  /** What the sidebar shows for the signed-in user: their email, or the demo name. */
  label: string;
  chatId: string | undefined;
  /** The skills page in place of a chat. */
  showSkills: boolean;
  navigate: (path: string) => void;
  onSignOut: () => void;
}

const SIDEBAR_DEFAULT = 240;
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 480;
const RAIL_WIDTH = 52;
const CHAT_MIN = 320;
const PREVIEW_MIN = 360;

function Workspace({ uid, label, chatId, showSkills, navigate, onSignOut }: WorkspaceProps) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>([]);
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PublishedDetails | null>(null);
  const [collapsed, setCollapsed] = useStoredState("layout.sidebarCollapsed", false);
  const [sidebarWidth, setSidebarWidth] = useStoredState("layout.sidebarWidth", SIDEBAR_DEFAULT);
  // The chat column's width beside an open preview; null splits the space 40/60.
  const [chatWidth, setChatWidth] = useStoredState<number | null>("layout.chatWidth", null);
  const chatRef = useRef<HTMLElement>(null);

  const loadSkills = useCallback(() => {
    api.skills().then(
      (list) => {
        setSkills(list);
        setSkillsError(null);
      },
      (e: Error) => setSkillsError(e.message),
    );
  }, []);
  const loadChats = useCallback(() => void api.chats().then(setChats, () => {}), []);
  const loadArtifacts = useCallback(() => void api.artifacts().then(setArtifacts, () => {}), []);
  const loadFiles = useCallback(() => void api.files().then(setFiles, () => {}), []);
  // After a run: it may have named the chat, published, saved files (run_python) or proposed a skill.
  const refresh = useCallback(() => {
    loadChats();
    loadArtifacts();
    loadFiles();
    loadSkills();
  }, [loadChats, loadArtifacts, loadFiles, loadSkills]);
  useEffect(refresh, [refresh]);
  useEffect(() => setPreview(null), [chatId]);

  // Skills the agent proposed in a chat wait, off, for the user to review.
  const proposed = (skills ?? []).filter((s) => s.origin === "agent" && !s.enabled).length;

  const newChat = async () => {
    const chat = await api.createChat();
    loadChats();
    navigate(`/c/${chat.id}`);
  };

  const onArtifact = useCallback(
    (artifact: PublishedDetails) => {
      setPreview(artifact);
      loadArtifacts();
    },
    [loadArtifacts],
  );

  const upload = async (file: File | undefined) => {
    if (!file) return;
    await api.upload(file);
    loadFiles();
  };

  return (
    <div
      className={preview ? "workspace with-preview" : "workspace"}
      style={
        {
          "--sidebar-w": `${collapsed ? RAIL_WIDTH : sidebarWidth}px`,
          "--chat-w": chatWidth === null ? "40%" : `${chatWidth}px`,
        } as CSSProperties
      }
    >
      {collapsed ? (
        <aside className="sidebar rail">
          <button type="button" onClick={() => setCollapsed(false)} title="Show the sidebar" aria-label="Show the sidebar">
            »
          </button>
          <button type="button" className="primary" onClick={newChat} title="New chat" aria-label="New chat">
            +
          </button>
        </aside>
      ) : (
        <aside className="sidebar">
          <div className="sidebar-top">
            <button type="button" className="primary" onClick={newChat}>
              + New chat
            </button>
            <button type="button" onClick={() => setCollapsed(true)} title="Hide the sidebar" aria-label="Hide the sidebar">
              «
            </button>
          </div>
          <h3>Chats</h3>
          <nav>
            {chats.map((chat) => (
              <a
                key={chat.id}
                href={`/c/${chat.id}`}
                className={chat.id === chatId ? "active" : ""}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`/c/${chat.id}`);
                }}
              >
                {chat.title}
              </a>
            ))}
          </nav>
          <h3>Artifacts</h3>
          <nav>
            {artifacts.map((a) => (
              <a key={a.id} href={`/a/${a.id}`} target="_blank" rel="noreferrer">
                {a.title} <small>v{a.latest}</small>
              </a>
            ))}
          </nav>
          <h3>Skills</h3>
          <nav>
            <a
              href="/skills"
              className={showSkills ? "active" : ""}
              onClick={(e) => {
                e.preventDefault();
                navigate("/skills");
              }}
            >
              {(skills ?? []).filter(isActive).length} on, {skills?.length ?? 0} in all
              {proposed > 0 && <small> · {proposed} to review</small>}
            </a>
          </nav>
          <h3>Files</h3>
          <nav>
            {files.map((f) => (
              <span key={f.path} title={`${f.size} bytes`}>
                {f.path}
              </span>
            ))}
            <label className="upload">
              Upload a file
              <input type="file" hidden onChange={(e) => upload(e.target.files?.[0])} />
            </label>
          </nav>
          <footer>
            <span title={label}>{label}</span>
            <button type="button" onClick={onSignOut}>
              Sign out
            </button>
          </footer>
        </aside>
      )}
      <ResizeHandle
        label="Sidebar width"
        width={sidebarWidth}
        min={SIDEBAR_MIN}
        max={() => SIDEBAR_MAX}
        onResize={setSidebarWidth}
        onReset={() => setSidebarWidth(SIDEBAR_DEFAULT)}
        disabled={collapsed}
      />
      <main className="main" ref={chatRef}>
        {showSkills ? (
          <ErrorBoundary what="skills">
            <SkillsView skills={skills} loadError={skillsError} reload={loadSkills} />
          </ErrorBoundary>
        ) : chatId ? (
          <ErrorBoundary key={chatId} what="this chat">
            <ChatView chatId={chatId} onArtifact={onArtifact} onActivity={refresh} />
          </ErrorBoundary>
        ) : (
          <div className="panel-empty">
            <button type="button" className="primary" onClick={newChat}>
              Start a chat
            </button>
          </div>
        )}
      </main>
      {preview && (
        <ResizeHandle
          label="Chat width"
          width={chatWidth ?? chatRef.current?.offsetWidth ?? CHAT_MIN}
          min={CHAT_MIN}
          max={() => (chatRef.current?.parentElement?.offsetWidth ?? innerWidth) - (collapsed ? RAIL_WIDTH : sidebarWidth) - PREVIEW_MIN}
          onResize={setChatWidth}
          onReset={() => setChatWidth(null)}
        />
      )}
      {preview && (
        <ErrorBoundary key={preview.artifactId} what="the preview">
          <ArtifactPanel artifactId={preview.artifactId} latestKnown={preview.version} uid={uid} onClose={() => setPreview(null)} />
        </ErrorBoundary>
      )}
    </div>
  );
}
