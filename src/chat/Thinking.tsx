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
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
  return minutes % 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${Math.floor(minutes / 60)}h`;
}

/**
 * Three pulsing dots, a rotating status word with a shimmer, and the time since the run started. Screen readers hear
 * "Working" once, not every word or second; with reduced motion the word stays put and styles.css stops the animations.
 */
export function Thinking({ since }: { since?: number }) {
  const [word, setWord] = useState(() => nextWord());
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const timer = setInterval(() => setWord((current) => nextWord(current)), WORD_MS);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (since === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [since]);
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
      {since !== undefined && (
        <span className="thinking-time" aria-hidden="true">
          {formatElapsed(now - since)}
        </span>
      )}
      <span className="sr-only">Working…</span>
    </div>
  );
}

/**
 * Twelve rounded rays in two sets of six that grow and shrink in turn while the whole spark turns, so it spins and
 * changes shape at once. styles.css sets its accent color and the motion.
 */
export function Spark() {
  const ray = (angle: number) => <line key={angle} x1="12" y1="3" x2="12" y2="21" transform={`rotate(${angle} 12 12)`} />;
  return (
    <svg className="thinking-spark" viewBox="0 0 24 24" aria-hidden="true">
      <g className="thinking-spark-long">{[0, 60, 120].map(ray)}</g>
      <g className="thinking-spark-short">{[30, 90, 150].map(ray)}</g>
    </svg>
  );
}
