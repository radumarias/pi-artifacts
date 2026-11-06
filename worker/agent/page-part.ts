import { plural } from "../../shared/util.ts";

/** Lines around each place a `part` text occurs, and at most this many places. */
const PART_CONTEXT = 15;
const MAX_PARTS = 5;

/**
 * `html`, or the part of it `part` names: lines `from-to` (counted from 1), or the lines around each place a text
 * occurs (at most MAX_PARTS of them), each run of lines under the numbers it spans.
 */
export function pagePart(html: string, part?: string): string {
  if (!part?.trim()) return html;
  const lines = html.split("\n");
  const range = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(part);
  const runs: [number, number][] = [];
  if (range) {
    const from = Math.max(1, Number(range[1]));
    const to = Math.min(lines.length, Number(range[2]));
    if (from > to) return `The page has ${plural(lines.length, "line")}; lines ${part.trim()} are not in it.`;
    runs.push([from, to]);
  } else {
    for (let at = 0; at < lines.length && runs.length <= MAX_PARTS; at++) {
      if (!lines[at].includes(part)) continue;
      const from = Math.max(1, at + 1 - PART_CONTEXT);
      const to = Math.min(lines.length, at + 1 + PART_CONTEXT);
      const last = runs.at(-1);
      if (last && from <= last[1] + 1) last[1] = to;
      else runs.push([from, to]);
    }
    if (!runs.length) return `"${part}" is not in the page (${plural(lines.length, "line")}): pass other text, a line range, or no part for the whole page.`;
  }
  const shown = runs.slice(0, MAX_PARTS).map(([from, to]) => `Lines ${from}-${to} of ${lines.length}:\n${lines.slice(from - 1, to).join("\n")}`);
  return shown.join("\n\n") + (runs.length > MAX_PARTS ? `\n\n(It occurs in more places: pass longer text to find the one you mean.)` : "");
}
