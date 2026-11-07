import { ARCHIVE, checkManifest, MAX_IMPORT_FILE_BYTES, type ExportedArtifact, type ExportedChat } from "../../shared/data-export.ts";
import type { ArtifactMeta } from "../../shared/protocol.ts";
import { readZipFile, storedRange, zipDirectory, type ZipItem, type ZipSource } from "../../shared/unzip.ts";
import { errorMessage, formatBytes, mapLimit, toBase64 } from "../../shared/util.ts";
import { dataApi, type DraftJson } from "../api.ts";
import type { Progress } from "./export.ts";

export const KINDS = ["chats", "artifacts", "files", "skills", "agents"] as const;
type Kind = (typeof KINDS)[number];

/** What an import did: how many of each kind went in, how many were here already, and what failed, with why. */
export interface ImportReport {
  imported: Record<Kind, number>;
  skipped: Record<Kind, number>;
  failed: string[];
  /** The settings it set, where there were none. */
  settings: string[];
}

const PARALLEL = 4;
const FILES = ARCHIVE.file("");

/** A file the browser reads from disk, a part at a time. */
export function fileSource(file: Blob): ZipSource {
  return { size: file.size, read: async (start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer()) };
}

const counts = () => Object.fromEntries(KINDS.map((kind) => [kind, 0])) as Record<Kind, number>;

/**
 * Bring an export (shared/data-export.ts) into the signed-in user's account, a piece at a time: settings, skills,
 * agents, files, then each chat followed by its artifacts, then what pages saved. It adds to what is here and never replaces
 * anything, so after a failure the same zip is imported again and goes on where it stopped. Only an archive's own
 * failures throw (not an export, damaged); a piece that fails is reported and the rest go on.
 */
export async function importData(zip: Blob, onProgress: (progress: Progress) => void): Promise<ImportReport> {
  const source = fileSource(zip);
  const items = new Map((await zipDirectory(source)).map((item) => [item.name, item]));
  /** An entry as a blob: a stored one (as exports are) is a slice of the zip, read from disk only as it is sent. */
  const blobOf = async (item: ZipItem): Promise<Blob> => {
    const range = await storedRange(source, item);
    return range ? zip.slice(...range) : new Blob([await readZipFile(source, item)]);
  };
  const read = async (name: string) => {
    const item = items.get(name);
    return item ? readZipFile(source, item) : null;
  };
  const readJson = async <T>(name: string): Promise<T | null> => {
    const bytes = await read(name);
    return bytes && (JSON.parse(new TextDecoder().decode(bytes)) as T);
  };
  const manifest = checkManifest(await readJson(ARCHIVE.manifest).catch(() => null));
  if ("error" in manifest) throw new Error(manifest.error);

  const report: ImportReport = { imported: counts(), skipped: counts(), failed: [], settings: [] };
  const fileItems = [...items.values()].filter((item) => item.name.startsWith(FILES));
  // A damaged entry is left out, as checkManifest checks only that there is a list.
  const agents = (manifest.account.agents ?? []).filter((agent) => typeof agent === "object" && agent !== null);
  const steps = {
    done: 0,
    total: 2 + manifest.account.skills.length + agents.length + fileItems.length + manifest.chats.length + manifest.artifacts.length,
  };
  const step = (now: string) => onProgress({ ...steps, now });
  /** Run one step: its failure is reported under `what`, and the import goes on. Whether it went in. */
  const attempt = async (what: string, run: () => Promise<void>): Promise<boolean> => {
    step(what);
    try {
      await run();
      return true;
    } catch (error) {
      report.failed.push(`${what}: ${errorMessage(error)}`);
      return false;
    } finally {
      steps.done++;
    }
  };

  const plan = await dataApi.plan({ chats: manifest.chats.map((chat) => chat.id), artifacts: manifest.artifacts.map(({ id, chatId }) => ({ id, chatId })) });
  const moved = Object.fromEntries(Object.entries(plan.artifacts).flatMap(([from, to]) => ("id" in to && to.id !== from ? [[from, to.id]] : [])));
  const newId = (id: string) => moved[id] ?? id;

  await attempt("Settings", async () => {
    const { systemPrompt, model, builtinSkillsOff } = manifest.account;
    report.settings = (await dataApi.importSettings({ systemPrompt, model, builtinSkillsOff })).applied;
  });

  for (const skill of manifest.account.skills) {
    await attempt(`Skill ${skill.name}`, async () => {
      const files = await Promise.all(
        (skill.files ?? []).map(async (file) => {
          const bytes = await read(ARCHIVE.skillFile(skill.name, file.path));
          if (!bytes) throw new Error(`the zip lacks its file ${file.path}`);
          return { path: file.path, data: toBase64(bytes), ...(file.binary && { binary: true as const }) };
        }),
      );
      const { skipped } = await dataApi.importSkill(skill, files);
      report[skipped ? "skipped" : "imported"].skills++;
    });
  }

  // Before the chats, whose rosters point at them: each one's id here, by its id in the export.
  const agentIds: Record<string, string> = {};
  for (const agent of agents) {
    await attempt(`Agent @${agent.name}`, async () => {
      const { id, skipped } = await dataApi.importAgent(agent);
      if (typeof agent.id === "string") agentIds[agent.id] = id;
      report[skipped ? "skipped" : "imported"].agents++;
    });
  }

  await mapLimit(fileItems, PARALLEL, (item) => {
    const path = item.name.slice(FILES.length);
    return attempt(path, async () => {
      if (item.size > MAX_IMPORT_FILE_BYTES) throw new Error(`over ${formatBytes(MAX_IMPORT_FILE_BYTES)}, the most one file can be`);
      const { skipped } = await dataApi.importFile(path, await blobOf(item));
      report[skipped ? "skipped" : "imported"].files++;
    });
  });

  const importChat = (chat: ExportedChat) =>
    attempt(`Chat “${chat.title}”`, async () => {
      if (plan.chats[chat.id] === "exists") {
        report.skipped.chats++;
        return;
      }
      await dataApi.importChatBegin(chat.id, { from: manifest.uid, artifacts: moved, agents: agentIds });
      for (let n = 1; n <= chat.parts; n++) {
        const item = items.get(ARCHIVE.chatPart(chat.id, n));
        if (!item) throw new Error(`the zip lacks part ${n} of it`);
        await dataApi.importChatPart(chat.id, await blobOf(item));
      }
      const drafts = await readJson<DraftJson[]>(ARCHIVE.chatDrafts(chat.id));
      if (drafts?.length) {
        const mapped = drafts.map((draft) => (typeof draft.artifactId === "string" ? { ...draft, artifactId: newId(draft.artifactId) } : draft));
        await dataApi.importChatDrafts(chat.id, mapped);
      }
      await dataApi.importChatFinish(chat.id, chat);
      report.imported.chats++;
    });

  const importArtifact = (artifact: ExportedArtifact, chatHere: boolean) =>
    attempt(`Artifact “${artifact.title}”`, async () => {
      const target = plan.artifacts[artifact.id];
      if (!target) throw new Error("not planned");
      if ("error" in target) throw new Error(target.error);
      if (!chatHere) throw new Error("its chat was not imported");
      const meta = await readJson<ArtifactMeta>(ARCHIVE.artifactMeta(artifact.id));
      if (!meta) throw new Error("the zip lacks it");
      const missing = meta.versions.filter((version) => version.version > target.latest);
      if (!missing.length) {
        report.skipped.artifacts++;
        return;
      }
      for (const version of missing) {
        const html = await read(ARCHIVE.artifactPage(artifact.id, version.version));
        if (!html) throw new Error(`the zip lacks version ${version.version}`);
        await dataApi.importArtifactVersion(target.id, {
          chatId: artifact.chatId,
          title: meta.title,
          createdAt: meta.createdAt,
          version,
          html: new TextDecoder().decode(html),
        });
      }
      report.imported.artifacts++;
    });

  // Each chat, then its artifacts: an artifact goes only into a chat the user has. Chats side by side.
  const byChat = new Map<string, ExportedArtifact[]>();
  for (const artifact of manifest.artifacts) byChat.set(artifact.chatId, [...(byChat.get(artifact.chatId) ?? []), artifact]);
  await mapLimit(manifest.chats, PARALLEL, async (chat) => {
    const here = await importChat(chat);
    for (const artifact of byChat.get(chat.id) ?? []) await importArtifact(artifact, here);
    byChat.delete(chat.id);
  });
  for (const artifact of [...byChat.values()].flat()) await importArtifact(artifact, false);

  await attempt("What pages saved", async () => {
    const values = manifest.account.pageValues.map((entry) => ({ ...entry, artifactId: newId(entry.artifactId) }));
    if (values.length) await dataApi.importPageValues(values);
  });
  onProgress({ ...steps, now: "Done" });
  return report;
}
