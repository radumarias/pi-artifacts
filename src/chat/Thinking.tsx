import { useEffect, useState } from "react";

/** Playful status words shown while the agent waits on the model. */
export const THINKING_WORDS = [
  "Pondering",
  "Cultivating",
  "Brewing",
  "Mulling",
  "Tinkering",
  "Conjuring",
  "Noodling",
  "Percolating",
  "Sketching",
  "Untangling",
  "Simmering",
  "Musing",
  "Wrangling",
  "Crafting",
  "Weaving",
  "Distilling",
  "Ruminating",
  "Hatching",
  "Calibrating",
  "Assembling",
];

/** Matches two sweeps of the shimmer in styles.css, so each word starts and ends on a full sweep. */
const WORD_MS = 4_000;

/** A random word, never the one showing now. */
export function nextWord(current?: string, random = Math.random): string {
  const choices = THINKING_WORDS.filter((word) => word !== current);
  return choices[Math.floor(random() * choices.length)];
}

/** Time since `ms` ago, the way a stopwatch reads it: "12s", "2m 21s", "2m", "1h 5m". */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  const [hours, minutes] = [Math.floor(seconds / 3_600), Math.floor(seconds / 60) % 60];
  if (hours) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes) return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
  return `${seconds}s`;
}

/**
 * Three pulsing dots, a rotating status word with a shimmer, and the time since the run started. Screen readers hear
 * "Working" once, not every word or second; with reduced motion the word stays put and styles.css stops the animations.
 */
export function Thinking({ since }: { since: number }) {
  const [word, setWord] = useState(() => nextWord());
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const timer = setInterval(() => setWord((current) => nextWord(current)), WORD_MS);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="thinking" role="status">
      <span className="thinking-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {/* Keyed so each new word fades in and starts its shimmer from the left. */}
      <span key={word} className="thinking-word" aria-hidden="true">
        {word}
      </span>
      <span className="thinking-time" aria-hidden="true">
        {formatElapsed(now - since)}
      </span>
      <span className="sr-only">Working…</span>
    </div>
  );
}
