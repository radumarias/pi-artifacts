/** What a tool hands the model: text, cut to what fits in a turn. */

export const MAX_TOOL_TEXT = 16_000;

export const text = (value: string) => [{ type: "text" as const, text: value }];

export function clip(value: string): string {
  return value.length <= MAX_TOOL_TEXT ? value : `${value.slice(0, MAX_TOOL_TEXT)}\n… [${value.length - MAX_TOOL_TEXT} more characters cut]`;
}
