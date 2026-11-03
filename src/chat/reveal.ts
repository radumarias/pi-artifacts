import { useEffect, useRef, useState } from "react";

/** About how long apart a streaming answer's steps arrive: how often the chat commits it (PROGRESS in worker/chat-agent.ts). */
export const STEP_MS = 1_000;
/** How often revealed text grows: about as often as the answer itself used to arrive. */
const TICK_MS = 80;

/** How far into a streaming text the reader has been shown, and how fast the rest is coming. */
export interface Reveal {
  /** The text as it last arrived. */
  target: string;
  /** How much of it is shown, in UTF-16 units. */
  shown: number;
  /** Units a millisecond: what reveals the backlog in about STEP_MS. */
  rate: number;
  /** When `shown` last grew. */
  at: number;
}

/**
 * The reveal after `text` arrives at `now`. Text that continues what arrived before is revealed over about STEP_MS,
 * from where the reader is; anything else (the first text, or a text that changed rather than grew) shows at once.
 */
export function revealTo(reveal: Reveal | undefined, text: string, now: number): Reveal {
  if (!reveal || !text.startsWith(reveal.target)) return { target: text, shown: text.length, rate: 0, at: now };
  const shown = Math.min(reveal.shown, text.length);
  return { target: text, shown, rate: (text.length - shown) / STEP_MS, at: now };
}

/** The reveal `now`, grown by the time since it last grew; never cutting a character in two. */
export function revealAt(reveal: Reveal, now: number): Reveal {
  if (reveal.shown >= reveal.target.length) return reveal;
  let shown = Math.min(reveal.target.length, reveal.shown + Math.max(1, Math.round(reveal.rate * (now - reveal.at))));
  const code = reveal.target.charCodeAt(shown - 1);
  if (code >= 0xd800 && code <= 0xdbff) shown++;
  return { ...reveal, shown, at: now };
}

/**
 * A streaming answer's text as the reader sees it. The chat sends a streaming answer about once a second (each step is
 * stored, and storing it often is costly), so a step's new text is revealed a little at a time until the next one
 * comes, and reads as typed rather than in jumps. Text already there when it first renders (opening a chat mid-answer)
 * shows at once.
 */
export function useRevealedText(text: string): string {
  const reveal = useRef<Reveal | undefined>(undefined);
  if (reveal.current?.target !== text) reveal.current = revealTo(reveal.current, text, performance.now());
  const [, rerender] = useState(0);
  const shown = reveal.current.shown;
  const done = shown >= text.length;
  useEffect(() => {
    if (done) return;
    const timer = setInterval(() => {
      const current = reveal.current;
      if (!current) return;
      reveal.current = revealAt(current, performance.now());
      rerender((n) => n + 1);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [done, text]);
  return text.slice(0, shown);
}
