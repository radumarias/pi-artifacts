import { clip as clipTo } from "../../shared/util.ts";

/** What a tool hands the model: text, cut to what fits in a turn. */

export const MAX_TOOL_TEXT = 16_000;

export const text = (value: string) => [{ type: "text" as const, text: value }];

export const clip = (value: string) => clipTo(value, MAX_TOOL_TEXT);
