import { ARCHIVE, type ExportedChat, type ExportManifest } from "../../shared/data-export.ts";
import { fromBase64, mapLimit } from "../../shared/util.ts";
import { zipStream, type ZipEntry } from "../../shared/zip.ts";
import { api, dataApi } from "../api.ts";

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
async function fetched(url: string): Promise<Blob | null> {
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  return response.blob();
}

/**
 * Everything the signed-in user has, as one zip (shared/data-export.ts ARCHIVE), read a piece at a time: first the
 * chats' storage and the artifacts' versions, which say how many more pieces there are, then the zip itself, each file
 * fetched when its turn comes. `onProgress` hears each step.
 */
export async function exportData(onProgress: (progress: Progress) => void): Promise<{ zip: Blob; manifest: ExportManifest }> {
  const start = await dataApi.exportStart();
  const steps = { done: 0, total: start.chats.length + start.artifacts.length };
  const step = (now: string) => onProgress({ ...steps, now });
  const entries: ZipEntry[] = [];

  const chats: ExportedChat[] = [];
  for (const chat of start.chats) {
    step(`Chat “${chat.title}”`);
    let parts = 0;
    let page = await dataApi.exportChatPart(chat.id);
    for (;;) {
      // Kept as a blob, which the browser may keep on disk, rather than as parsed JSON.
      const blob = jsonBlob(page.part);
      entries.push(blobEntry(ARCHIVE.chatPart(chat.id, ++parts), async () => blob));
      if (!page.next) break;
      page = await dataApi.exportChatPart(chat.id, page.next);
    }
    const drafts = await dataApi.exportDrafts(chat.id);
    if (drafts.length) entries.push(blobEntry(ARCHIVE.chatDrafts(chat.id), async () => jsonBlob(drafts)));
    chats.push({ ...chat, parts });
    steps.done++;
  }

  const metas = await mapLimit(start.artifacts, PARALLEL, async (artifact) => {
    step(`Artifact “${artifact.title}”`);
    const meta = await dataApi.exportArtifact(artifact.id).catch(() => null);
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
    let read: Promise<Map<string, Uint8Array<ArrayBuffer>>> | undefined;
    const files = () => (read ??= dataApi.exportSkillFiles(skill.name).then(({ files }) => new Map(files.map((file) => [file.path, fromBase64(file.data)]))));
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

  const manifest: ExportManifest = { ...start, chats, artifacts };
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
  return { zip: new Blob([zip], { type: "application/zip" }), manifest };
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
