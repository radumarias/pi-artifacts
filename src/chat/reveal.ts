import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { STREAM_STEP_MS } from "../../shared/protocol.ts";

/** How often revealed text grows: as often as a streaming answer arrived before it came in steps of STREAM_STEP_MS. */
const TICK_MS = 100;

/** How far into a streaming text the reader has been shown, and how fast the rest is coming. */
export interface Reveal {
  /** The text as it last arrived. */
  target: string;
  /** How much of it is shown, in UTF-16 units. */
  shown: number;
  /** How much was shown when the text last arrived: `rate` counts from here. */
  from: number;
  /** Units a millisecond: what reveals the backlog in about STREAM_STEP_MS. */
  rate: number;
  /** When the text last arrived. */
  at: number;
}

/**
 * The reveal after `text` arrives at `now`. Text that continues what arrived before is revealed over about
 * STREAM_STEP_MS, from where the reader is; anything else (the first text, or a text that changed rather than grew)
 * shows at once.
 */
export function revealTo(reveal: Reveal | undefined, text: string, now: number): Reveal {
  if (!reveal || !text.startsWith(reveal.target)) return { target: text, shown: text.length, from: text.length, rate: 0, at: now };
  return { target: text, shown: reveal.shown, from: reveal.shown, rate: (text.length - reveal.shown) / STREAM_STEP_MS, at: now };
}

/**
 * The reveal `now`: by the time since the text arrived, so no tick's rounding is lost, and by at least one unit a tick;
 * never cutting a character in two.
 */
export function revealAt(reveal: Reveal, now: number): Reveal {
  if (reveal.shown >= reveal.target.length) return reveal;
  const due = reveal.from + Math.round(reveal.rate * (now - reveal.at));
  let shown = Math.min(reveal.target.length, Math.max(reveal.shown + 1, due));
  const code = reveal.target.charCodeAt(shown - 1);
  if (code >= 0xd800 && code <= 0xdbff) shown++;
  return { ...reveal, shown };
}

/**
 * A streaming answer's text as the reader sees it. The chat sends a streaming answer in steps of STREAM_STEP_MS (each
 * step is stored, and storing it often is costly), so a step's new text is revealed a little at a time until the next
 * one comes, and reads as typed rather than in jumps. Text already there when it first renders (opening a chat
 * mid-answer) shows at once. `onGrow` runs after each growth reaches the page, so the list can follow it.
 */
export function useRevealedText(text: string, onGrow?: () => void): string {
  const reveal = useRef<Reveal | undefined>(undefined);
  if (reveal.current?.target !== text) reveal.current = revealTo(reveal.current, text, performance.now());
  const [, rerender] = useState(0);
  const { shown } = reveal.current;
  const done = shown >= text.length;
  useEffect(() => {
    if (done) return;
    const timer = setInterval(() => {
      if (reveal.current) reveal.current = revealAt(reveal.current, performance.now());
      rerender((n) => n + 1);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [done, text]);
  useLayoutEffect(() => onGrow?.(), [shown, onGrow]);
  return text.slice(0, shown);
}
