import { ARCHIVE, type ExportedChat, type ExportManifest } from "../../shared/data-export.ts";
import { fromBase64, mapLimit, memoAsync } from "../../shared/util.ts";
import { zipStream, type ZipEntry } from "../../shared/zip.ts";
import { api, dataApi, fetchBlob } from "../api.ts";

/** How far an export or import is: `done` of `total` steps, and what it is on now. */
export interface Progress {
  done: number;
  total: number;
  now: string;
}

/** How many pieces are fetched at once. */
const PARALLEL = 4;

const jsonBlob = (value: unknown) => new Blob([JSON.stringify(value)], { type: "application/json" });

/** `blob` as a zip entry: read whole first, so its size is what the zip says (a fetched body may arrive compressed). */
const blobEntry = (name: string, blob: () => Promise<Blob | null>, modified = new Date()): ZipEntry => ({
  name,
  open: async () => {
    const read = await blob();
    return read && { size: read.size, modified, body: read.stream() };
  },
});

/** A piece's body, or null when it is gone (deleted since it was listed). */
const fetched = async (url: string) => (await fetchBlob(url))?.blob ?? null;

/** For a failed read of a piece: null when the piece is gone (404), so the export goes on without it; any other failure stops it. */
const orGone = (error: unknown): null => {
  if ((error as { status?: number }).status === 404) return null;
  throw error;
};

/**
 * Everything the signed-in user has, as one zip (shared/data-export.ts ARCHIVE), read a piece at a time: first the
 * chats' storage and the artifacts' versions, which say how many more pieces there are, then the zip itself, each file
 * fetched when its turn comes. `onProgress` hears each step.
 */
export async function exportData(onProgress: (progress: Progress) => void): Promise<Blob> {
  const start = await dataApi.exportStart();
  const steps = { done: 0, total: start.chats.length + start.artifacts.length };
  const step = (now: string) => onProgress({ ...steps, now });
  const entries: ZipEntry[] = [];

  // Each chat's parts and drafts kept as blobs, which the browser may keep on disk, rather than as parsed JSON.
  // A chat deleted since it was listed is left out, as a gone file or page is.
  const read = await mapLimit(start.chats, PARALLEL, async (chat): Promise<{ chat: ExportedChat; entries: ZipEntry[] } | null> => {
    step(`Chat “${chat.title}”`);
    const parts: Blob[] = [];
    let page = await dataApi.exportChatPart(chat.id);
    while (page) {
      parts.push(page.part);
      page = page.next ? await dataApi.exportChatPart(chat.id, page.next) : null;
    }
    const drafts = parts.length ? await dataApi.exportDrafts(chat.id).catch(orGone) : null;
    steps.done++;
    if (!drafts) return null;
    const draftsBlob = drafts.length ? jsonBlob(drafts) : null;
    return {
      chat: { ...chat, parts: parts.length },
      entries: [
        ...parts.map((part, i) => blobEntry(ARCHIVE.chatPart(chat.id, i + 1), async () => part)),
        ...(draftsBlob ? [blobEntry(ARCHIVE.chatDrafts(chat.id), async () => draftsBlob)] : []),
      ],
    };
  });
  const chats = read.filter((chat) => chat !== null);
  for (const chat of chats) entries.push(...chat.entries);

  const metas = await mapLimit(start.artifacts, PARALLEL, async (artifact) => {
    step(`Artifact “${artifact.title}”`);
    const meta = await dataApi.exportArtifact(artifact.id).catch(orGone);
    steps.done++;
    return meta;
  });
  const artifacts = start.artifacts.filter((_, i) => metas[i]);
  for (const meta of metas) {
    if (!meta) continue;
    entries.push(blobEntry(ARCHIVE.artifactMeta(meta.id), async () => jsonBlob(meta)));
    for (const { version, publishedAt } of meta.versions) {
      entries.push(blobEntry(ARCHIVE.artifactPage(meta.id, version), () => fetched(api.artifactSourceUrl(meta.id, version)), new Date(publishedAt)));
    }
  }

  // A skill's files come in one answer: read once, by whichever of its entries opens first.
  for (const skill of start.account.skills) {
    if (!skill.files?.length) continue;
    const files = memoAsync(async () => new Map((await dataApi.exportSkillFiles(skill.name)).files.map((file) => [file.path, fromBase64(file.data)])));
    for (const file of skill.files) {
      entries.push(
        blobEntry(ARCHIVE.skillFile(skill.name, file.path), async () => {
          const bytes = (await files()).get(file.path);
          return bytes ? new Blob([bytes]) : null;
        }),
      );
    }
  }
  for (const file of start.files) entries.push(blobEntry(ARCHIVE.file(file.path), () => fetched(api.fileUrl(file.path))));

  const manifest: ExportManifest = { ...start, chats: chats.map((entry) => entry.chat), artifacts };
  entries.unshift(blobEntry(ARCHIVE.manifest, async () => jsonBlob(manifest)));

  // Now the zip: a step per entry, its files fetched as it gets to them.
  steps.done = 0;
  steps.total = entries.length;
  const counted = entries.map(
    (entry): ZipEntry => ({
      name: entry.name,
      open: async () => {
        step(entry.name);
        const opened = await entry.open();
        steps.done++;
        return opened;
      },
    }),
  );
  const zip = await new Response(zipStream(counted)).blob();
  onProgress({ ...steps, now: "Done" });
  return new Blob([zip], { type: "application/zip" });
}

/** Save `blob` as `name` in the browser's downloads. */
export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** The export's file name: the app's and the day's. */
export const exportName = (at = new Date()) => `pi-artifacts-export-${at.toISOString().slice(0, 10)}.zip`;
