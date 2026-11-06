import { ARCHIVE, checkManifest, MAX_IMPORT_FILE_BYTES, type ExportManifest } from "../../shared/data-export.ts";
import type { ArtifactMeta } from "../../shared/protocol.ts";
import { readZipFile, zipDirectory, type ZipSource } from "../../shared/unzip.ts";
import { errorMessage, formatBytes, mapLimit, toBase64 } from "../../shared/util.ts";
import { dataApi } from "../api.ts";
import type { Progress } from "./export.ts";

/** What an import did: how many of each kind went in, how many were here already, and what failed, with why. */
export interface ImportReport {
  imported: Record<Kind, number>;
  skipped: Record<Kind, number>;
  failed: string[];
  /** The settings it set, where there were none. */
  settings: string[];
}

type Kind = "chats" | "artifacts" | "files" | "skills";

const PARALLEL = 4;

/** A file the browser reads from disk, a part at a time. */
export function fileSource(file: Blob): ZipSource {
  return { size: file.size, read: async (start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer()) };
}

/**
 * Bring an export (shared/data-export.ts) into the signed-in user's account, a piece at a time: settings, skills,
 * files, then each chat followed by its artifacts, then what pages saved. It adds to what is here and never replaces
 * anything, so after a failure the same zip is imported again and goes on where it stopped. Only an archive's own
 * failures throw (not an export, damaged); a piece that fails is reported and the rest go on.
 */
export async function importData(zip: Blob, onProgress: (progress: Progress) => void): Promise<ImportReport> {
  const source = fileSource(zip);
  const items = new Map((await zipDirectory(source)).map((item) => [item.name, item]));
  const read = async (name: string): Promise<Uint8Array<ArrayBuffer> | null> => {
    const item = items.get(name);
    return item ? readZipFile(source, item) : null;
  };
  const readJson = async <T>(name: string): Promise<T | null> => {
    const bytes = await read(name);
    return bytes && (JSON.parse(new TextDecoder().decode(bytes)) as T);
  };
  const checked = checkManifest(await readJson(ARCHIVE.manifest).catch(() => null));
  if ("error" in checked) throw new Error(checked.error);
  const manifest: ExportManifest = checked;

  const report: ImportReport = {
    imported: { chats: 0, artifacts: 0, files: 0, skills: 0 },
    skipped: { chats: 0, artifacts: 0, files: 0, skills: 0 },
    failed: [],
    settings: [],
  };
  const fileItems = [...items.values()].filter((item) => item.name.startsWith("files/"));
  const steps = { done: 0, total: 3 + manifest.account.skills.length + fileItems.length + manifest.chats.length + manifest.artifacts.length };
  const step = (now: string) => onProgress({ ...steps, now });
  /** Run one step: its failure is reported under `what`, and the import goes on. */
  const attempt = async (what: string, run: () => Promise<void>) => {
    step(what);
    try {
      await run();
    } catch (error) {
      report.failed.push(`${what}: ${errorMessage(error)}`);
    }
    steps.done++;
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

  await mapLimit(fileItems, PARALLEL, (item) =>
    attempt(item.name.slice("files/".length), async () => {
      if (item.size > MAX_IMPORT_FILE_BYTES) throw new Error(`over ${formatBytes(MAX_IMPORT_FILE_BYTES)}, the most one file can be`);
      const { skipped } = await dataApi.importFile(item.name.slice("files/".length), new Blob([await readZipFile(source, item)]));
      report[skipped ? "skipped" : "imported"].files++;
    }),
  );

  // A chat, then its artifacts: an artifact goes only into a chat the user has.
  const imported = new Set<string>();
  for (const chat of manifest.chats) {
    await attempt(`Chat “${chat.title}”`, async () => {
      if (plan.chats[chat.id] === "exists") {
        report.skipped.chats++;
        imported.add(chat.id);
        return;
      }
      await dataApi.importChatBegin(chat.id, { from: manifest.uid, artifacts: moved });
      for (let n = 1; n <= chat.parts; n++) {
        const part = await read(ARCHIVE.chatPart(chat.id, n));
        if (!part) throw new Error(`the zip lacks part ${n} of it`);
        await dataApi.importChatPart(chat.id, new Blob([part]));
      }
      const drafts = await readJson<Record<string, unknown>[]>(ARCHIVE.chatDrafts(chat.id));
      if (drafts?.length) {
        const mapped = drafts.map((draft) => (typeof draft.artifactId === "string" ? { ...draft, artifactId: newId(draft.artifactId) } : draft));
        await dataApi.importChatDrafts(chat.id, mapped);
      }
      await dataApi.importChatFinish(chat.id, chat);
      report.imported.chats++;
      imported.add(chat.id);
    });
  }

  for (const artifact of manifest.artifacts) {
    await attempt(`Artifact “${artifact.title}”`, async () => {
      const target = plan.artifacts[artifact.id];
      if (!target) throw new Error("not planned");
      if ("error" in target) throw new Error(target.error);
      if (!imported.has(artifact.chatId)) throw new Error("its chat was not imported");
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
  }

  await attempt("What pages saved", async () => {
    const values = manifest.account.pageValues.map((entry) => ({ ...entry, artifactId: newId(entry.artifactId) }));
    if (values.length) await dataApi.importPageValues(values);
  });
  await attempt("Done", async () => {});
  return report;
}
