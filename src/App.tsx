import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type FormEvent } from "react";
import { ID_PATTERN, secondSeatUid, type ChatContents } from "../shared/protocol.ts";
import { chatFileRoute, MAX_LISTED } from "../shared/uploads.ts";
import { isActive, type SkillInfo } from "../shared/skills.ts";
import { errorMessage } from "../shared/util.ts";
import { AccountMenu } from "./AccountMenu.tsx";
import { BackToSite } from "./BackToSite.tsx";
import { api, inSecondSeat, type ArtifactSummary, type FileInfo, type Me } from "./api.ts";
import { ArtifactPanel } from "./artifact/ArtifactPanel.tsx";
import { ChatFilterBar, ChatList, isShared, UnreadDot, useChatFilter, useChatList } from "./chat/ChatList.tsx";
import { ChatView } from "./chat/ChatView.tsx";
import { MentionToasts, useMentionNotices } from "./chat/notify.tsx";
import { DeleteChat } from "./chat/DeleteChat.tsx";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { ChatFiles } from "./files/ChatFiles.tsx";
import { FilePreview } from "./files/FilePreview.tsx";
import { FilesNav, useUploads } from "./files/FilesNav.tsx";
import { carriesFiles, fromDrop } from "./files/pick.ts";
import { isBoolean, MenuButton, ResizeHandle, SectionHead, useMediaQuery, useStoredState } from "./layout.tsx";
import { useLatest, useSidebarSocket } from "./sidebar.ts";
import { SkillsView } from "./skills/SkillsView.tsx";

/** The app's location, path and query, and a way to go elsewhere in it without loading the page again. */
function usePath(): [URL, (path: string) => void] {
  const [href, setHref] = useState(location.href);
  useEffect(() => {
    const onPop = () => setHref(location.href);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((next: string) => {
    const url = new URL(next, location.href);
    if (url.href !== location.href) history.pushState(null, "", url);
    setHref(url.href);
  }, []);
  return [useMemo(() => new URL(href), [href]), navigate];
}

export function App() {
  const [url, navigate] = usePath();
  const path = url.pathname;
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

  const join = path.match(/^\/join\/([a-z0-9.-]+)$/);
  if (join) return <Join token={join[1]} navigate={navigate} />;

  const chatId = path.match(/^\/c\/([a-z0-9]+)$/)?.[1];
  // An artifact's page links back to the chat that builds it, with the artifact open beside it.
  const opening = url.searchParams.get("artifact");
  return (
    <Workspace
      uid={me.uid}
      label={me.email ?? me.uid}
      chatId={chatId}
      secondSeat={chatId !== undefined && inSecondSeat(url.search)}
      opening={chatId && opening && ID_PATTERN.test(opening) ? opening : undefined}
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

/** An artifact in the sidebar: it opens on its own page. */
function ArtifactLink({ artifact: a }: { artifact: ArtifactSummary }) {
  return (
    <a href={`/a/${a.id}`} target="_blank" rel="noreferrer" className={a.unread ? "nav-item unread" : "nav-item"}>
      <span className="nav-title">
        {a.title} <small>v{a.latest}</small>
      </span>
      {a.unread && <UnreadDot label="New version you have not opened" />}
    </a>
  );
}

/** An invite link: joining takes a click, so a link opened by accident (or prefetched) joins nobody. */
function Join({ token, navigate }: { token: string; navigate: (path: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const join = async () => {
    setJoining(true);
    try {
      navigate(`/c/${(await api.acceptInvite(token)).chatId}`);
    } catch (e) {
      setError(errorMessage(e));
      setJoining(false);
    }
  };
  return (
    <main className="sign-in">
      <div>
        <h1>Join a chat</h1>
        <p>You were invited to build artifacts together in someone's chat. Everyone in it sees the whole conversation, including what you write.</p>
        <button type="button" className="primary" disabled={joining} onClick={() => void join()}>
          Join the chat
        </button>{" "}
        <button type="button" onClick={() => navigate("/")}>
          Not now
        </button>
        {error && <p className="form-error">{error}</p>}
      </div>
    </main>
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
  /** The chat is open as the owner's second seat in it (secondSeat): a member, as the people they share it with are. */
  secondSeat: boolean;
  /** The artifact to show beside the chat when it opens, rather than the newest one it published. */
  opening: string | undefined;
  /** The skills page in place of a chat. */
  showSkills: boolean;
  navigate: (path: string) => void;
  onSignOut: () => void;
}

/** The artifact beside the chat, and the newest version the chat knows of, once it does. */
interface ArtifactPreview {
  artifactId: string;
  version?: number;
}

/** What shows beside the chat: an artifact, or a file: the user's own, or with `base` one of a chat shared with them. */
type Preview = ArtifactPreview | { file: string; base?: string };

const SIDEBAR_DEFAULT = 240;
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 480;
const RAIL_WIDTH = 52;
const CHAT_MIN = 320;
const PREVIEW_MIN = 360;
/** Phones and narrow windows: one column, the sidebar a menu that slides in over it (styles.css, the same width). */
const NARROW = "(max-width: 900px)";

function Workspace({ uid, label, chatId, secondSeat, opening, showSkills, navigate, onSignOut }: WorkspaceProps) {
  const { chats, load: loadChats, newSince } = useChatList(chatId);
  const [artifacts, loadArtifacts] = useLatest<ArtifactSummary[]>(api.artifacts, []);
  const [files, loadFiles] = useLatest<FileInfo[]>(api.files, []);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [skills, loadSkills] = useLatest<SkillInfo[] | null>(api.skills, null, (e) => setSkillsError(e?.message ?? null));
  const [preview, setPreview] = useState<Preview | null>(null);
  // In a chat someone shared with this user, what it holds of theirs: its files and artifacts, which the sidebar lists
  // beside the user's own (the owner's other files and artifacts stay theirs).
  // The owner's second seat sees the chat as they do.
  const guestChat = chatId && (secondSeat || chats.some((chat) => chat.id === chatId && chat.sharedBy)) ? chatId : undefined;
  const [contents, loadContents, setContents] = useLatest<ChatContents | null>(() => (guestChat ? api.chatContents(guestChat) : Promise.resolve(null)), null);
  // Sidebar sections start closed, so the chat list gets the room.
  const [chatFilesOpen, setChatFilesOpen] = useStoredState("layout.chatFilesOpen", false, isBoolean);
  // The chat whose deletion is being confirmed.
  const [deleting, setDeleting] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useStoredState("layout.sidebarCollapsed", false, isBoolean);
  // Narrow, the sidebar is a menu, open or closed, and never the rail.
  const narrow = useMediaQuery(NARROW);
  const [menuOpen, setMenuOpen] = useState(false);
  const rail = collapsed && !narrow;
  const chatFilter = useChatFilter(chats, chatId);
  const [artifactsOpen, setArtifactsOpen] = useStoredState("layout.artifactsOpen", false, isBoolean);
  const [sidebarWidth, setSidebarWidth] = useStoredState("layout.sidebarWidth", SIDEBAR_DEFAULT);
  // The chat column's width beside an open preview; null splits the space 40/60.
  const [chatWidth, setChatWidth] = useStoredState<number | null>("layout.chatWidth", null);
  const chatRef = useRef<HTMLElement>(null);

  useEffect(() => {
    loadArtifacts();
    loadFiles();
    loadSkills();
  }, [loadArtifacts, loadFiles, loadSkills]);
  useEffect(() => {
    setContents(() => null);
    loadContents();
  }, [guestChat, loadContents, setContents]);
  // A finished run may have saved files (run_python) or published: read them again.
  const onActivity = useCallback(() => {
    loadFiles();
    loadContents();
  }, [loadFiles, loadContents]);
  // Chats, artifacts and skills live in the user's directory, which says when they change. Files are not in it: a run
  // may have saved some (run_python), so they are read again after each one.
  // Someone tagging the user shows in the app, and in the browser while it is in the background.
  const notices = useMentionNotices(chatId, navigate);
  useSidebarSocket({ chats: loadChats, artifacts: loadArtifacts, skills: loadSkills }, notices.onMention);
  // Another chat shows its own artifacts: the one asked for at once, else the newest it published once it loads.
  // Going to the same chat without one asked for (its sidebar link, Back) keeps what it shows: the chat does not load
  // again, so it would not offer its newest artifact.
  const previewChat = useRef(chatId);
  useEffect(() => {
    if (opening) setPreview({ artifactId: opening });
    else if (previewChat.current !== chatId) setPreview(null);
    previewChat.current = chatId;
  }, [chatId, opening]);
  // A new publish always shows; the chat's newest artifact on load only when none was asked for, and not on a narrow
  // screen, where the preview would cover the chat just opened.
  const onArtifact = useCallback(
    (artifact: ArtifactPreview, loading?: boolean) => {
      if (!loading || (!opening && !narrow)) setPreview(artifact);
    },
    [opening, narrow],
  );

  // The menu closes once the user picked something in it: a chat, the skills, a file or an artifact to preview; and when
  // the window widens past NARROW, so it does not open again by itself when it narrows.
  useEffect(() => setMenuOpen(false), [chatId, showSkills, preview, narrow]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setMenuOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);
  const openMenu = useCallback(() => setMenuOpen(true), []);

  const openFile = useCallback((file: string) => setPreview({ file }), []);
  const chatFileBase = guestChat && chatFileRoute(guestChat);
  const openChatFile = useCallback((file: string) => chatFileBase && setPreview({ file, base: chatFileBase }), [chatFileBase]);
  const previewing = preview && "file" in preview ? preview : null;
  const closePreview = useCallback(() => setPreview(null), []);
  // A file deleted (from the sidebar, or with a chat) leaves the preview once a whole listing lacks it. Only when the
  // files are read again: a file just opened is in the listing it was opened from.
  useEffect(() => {
    if (files.length >= MAX_LISTED) return;
    setPreview((shown) => (shown && "file" in shown && !shown.base && !files.some((file) => file.path === shown.file) ? null : shown));
  }, [files]);

  // Skills the agent proposed in a chat wait, off, for the user to review.
  const proposed = (skills ?? []).filter((s) => s.origin === "agent" && !s.enabled).length;

  const newChat = async () => {
    const chat = await api.createChat();
    navigate(`/c/${chat.id}`);
  };

  const { status: uploadStatus, upload } = useUploads(loadFiles);
  // Files dragged over the app: entries counted, since entering a child element leaves its parent first. Only whether
  // the count is above zero is state, so crossing elements does not render the app again.
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const dropHandlers = {
    onDragEnter: (e: DragEvent) => {
      if (!carriesFiles(e.dataTransfer)) return;
      e.preventDefault();
      dragDepth.current++;
      setDragging(true);
    },
    onDragOver: (e: DragEvent) => {
      if (!carriesFiles(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: DragEvent) => {
      if (!carriesFiles(e.dataTransfer)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      setDragging(dragDepth.current > 0);
    },
    onDrop: (e: DragEvent) => {
      if (!carriesFiles(e.dataTransfer)) return;
      // Already taken: the chat's composer attaches files dropped on it to the message.
      const taken = e.defaultPrevented;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (taken) return;
      void fromDrop(e.dataTransfer).then(
        (picked) => (picked.length ? upload(picked) : undefined),
        (error) => alert(`Could not read the dropped files: ${errorMessage(error)}`),
      );
    },
  };

  // The owner's artifacts are theirs: only this chat's show, and only while it is open.
  const chatArtifacts = contents?.artifacts ?? [];
  return (
    <div
      className={["workspace", preview && "with-preview", dragging && "dragging"].filter(Boolean).join(" ")}
      {...dropHandlers}
      style={
        {
          "--sidebar-w": `${rail ? RAIL_WIDTH : sidebarWidth}px`,
          "--chat-w": chatWidth === null ? "40%" : `${chatWidth}px`,
        } as CSSProperties
      }
    >
      {rail ? (
        <aside className="sidebar rail">
          <BackToSite compact />
          <button type="button" onClick={() => setCollapsed(false)} title="Show the sidebar" aria-label="Show the sidebar">
            »
          </button>
          <button type="button" className="primary" onClick={newChat} title="New chat" aria-label="New chat">
            +
          </button>
        </aside>
      ) : (
        <aside className={narrow ? (menuOpen ? "sidebar drawer open" : "sidebar drawer") : "sidebar"}>
          <BackToSite />
          <div className="sidebar-top">
            <button type="button" className="primary" onClick={newChat}>
              + New chat
            </button>
            {narrow ? (
              <button type="button" onClick={() => setMenuOpen(false)} title="Close the menu" aria-label="Close the menu">
                ×
              </button>
            ) : (
              <button type="button" onClick={() => setCollapsed(true)} title="Hide the sidebar" aria-label="Hide the sidebar">
                «
              </button>
            )}
          </div>
          {/* Chats scroll here; artifacts, skills and the files panel stay below them. */}
          <div className="sidebar-scroll">
            <h3>Chats</h3>
            {chatFilter.bar && <ChatFilterBar {...chatFilter} />}
            <ChatList chats={chatFilter.shown} openId={chatId} navigate={navigate} onDelete={setDeleting} empty={chatFilter.empty} />
          </div>
          <section className="sidebar-pinned">
            <SectionHead name="Artifacts" count={artifacts.length + chatArtifacts.length} open={artifactsOpen} onToggle={setArtifactsOpen}>
              {/* Closed, the section still shows that an artifact has a version the user has not opened. */}
              {!artifactsOpen && artifacts.some((a) => a.unread) && <UnreadDot label="New versions you have not opened" />}
            </SectionHead>
            {/* A long list scrolls on its own, so skills and the files panel stay in view. */}
            {artifactsOpen && (
              <nav className="artifact-list">
                {chatArtifacts.length > 0 && <h4 className="nav-group">In this chat</h4>}
                {chatArtifacts.map((a) => (
                  <ArtifactLink key={a.id} artifact={a} />
                ))}
                {chatArtifacts.length > 0 && artifacts.length > 0 && <h4 className="nav-group">Yours</h4>}
                {artifacts.map((a) => (
                  <ArtifactLink key={a.id} artifact={a} />
                ))}
              </nav>
            )}
            {contents && chatFileBase && (
              <>
                <SectionHead name="Files in this chat" count={contents.files.length} open={chatFilesOpen} onToggle={setChatFilesOpen} />
                {chatFilesOpen && (
                  <ChatFiles files={contents.files} base={chatFileBase} openFile={previewing?.base ? previewing.file : null} onOpenFile={openChatFile} />
                )}
              </>
            )}
            <h3>Skills</h3>
            <nav>
              <a
                href="/skills"
                className={["nav-item", showSkills && "active", proposed > 0 && "unread"].filter(Boolean).join(" ")}
                onClick={(e) => {
                  e.preventDefault();
                  navigate("/skills");
                }}
              >
                <span className="nav-title">
                  {(skills ?? []).filter(isActive).length} on, {skills?.length ?? 0} in all
                  {proposed > 0 && <small> · {proposed} to review</small>}
                </span>
                {proposed > 0 && <UnreadDot label="Proposed skills to review" />}
              </a>
            </nav>
          </section>
          <FilesNav
            files={files}
            status={uploadStatus}
            upload={upload}
            openFile={previewing && !previewing.base ? previewing.file : null}
            onOpenFile={openFile}
            onDeleted={loadFiles}
          />
          <AccountMenu label={label} onSignOut={onSignOut} />
        </aside>
      )}
      <ResizeHandle
        label="Sidebar width"
        width={sidebarWidth}
        min={SIDEBAR_MIN}
        max={() => SIDEBAR_MAX}
        onResize={setSidebarWidth}
        onReset={() => setSidebarWidth(SIDEBAR_DEFAULT)}
        disabled={rail}
      />
      {narrow && menuOpen && <div className="drawer-backdrop" onClick={() => setMenuOpen(false)} aria-hidden="true" />}
      <main className="main" ref={chatRef}>
        {/* A chat has its own header, with the menu button in it. */}
        {narrow && (showSkills || !chatId) && (
          <header className="chat-header">
            <MenuButton onClick={openMenu} />
            <h1 className="chat-title">{showSkills ? "Skills" : "Chats"}</h1>
          </header>
        )}
        {showSkills ? (
          <ErrorBoundary what="skills">
            <SkillsView skills={skills} loadError={skillsError} reload={loadSkills} />
          </ErrorBoundary>
        ) : chatId ? (
          // A new chat view, with a new socket, also between the owner and their second seat in the same chat.
          <ErrorBoundary
            key={`${chatId}${secondSeat ? ".2" : ""}`}
            what="this chat"
            // The chat's own header, with the menu button, is gone with it: without this a phone could not leave it.
            head={
              narrow && (
                <header className="chat-header">
                  <MenuButton onClick={openMenu} />
                </header>
              )
            }
          >
            <ChatView
              chatId={chatId}
              title={chats.find((chat) => chat.id === chatId)?.title}
              onMenu={narrow ? openMenu : undefined}
              uid={secondSeat ? secondSeatUid(uid) : uid}
              newSince={newSince}
              onArtifact={onArtifact}
              onActivity={onActivity}
              onLeft={() => navigate("/")}
            />
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
          max={() => (chatRef.current?.parentElement?.offsetWidth ?? innerWidth) - (rail ? RAIL_WIDTH : sidebarWidth) - PREVIEW_MIN}
          onResize={setChatWidth}
          onReset={() => setChatWidth(null)}
        />
      )}
      {deleting && (
        <DeleteChat
          chatId={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            // Leaving the chat closes its preview; another chat's deletion leaves this one's open.
            if (deleting === chatId) navigate("/");
            // Its files may be gone too; the chat and artifact lists follow on their own.
            loadFiles();
          }}
        />
      )}
      {dragging && (
        <div className="drop-target" aria-hidden>
          Drop files or folders to upload them, or on the message box to send them with your message
        </div>
      )}
      {preview &&
        ("file" in preview ? (
          <ErrorBoundary key={`file:${preview.base ?? ""}:${preview.file}`} what="the preview">
            <FilePreview
              path={preview.file}
              files={preview.base ? (contents?.files ?? []) : files}
              onOpen={preview.base ? openChatFile : openFile}
              onClose={closePreview}
              base={preview.base}
            />
          </ErrorBoundary>
        ) : (
          <ErrorBoundary key={preview.artifactId} what="the preview">
            <ArtifactPanel artifactId={preview.artifactId} latestKnown={preview.version} uid={uid} onClose={closePreview} />
          </ErrorBoundary>
        ))}
      <MentionToasts {...notices} asking={chats.some(isShared)} />
    </div>
  );
}
