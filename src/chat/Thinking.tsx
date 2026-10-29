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

/**
 * A spinning spark and a rotating status word with a shimmer. Screen readers hear "Working" once, not every word;
 * with reduced motion the word stays put and styles.css stops the animations.
 */
export function Thinking() {
  const [word, setWord] = useState(() => nextWord());
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const timer = setInterval(() => setWord((current) => nextWord(current)), WORD_MS);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="thinking" role="status">
      <Spark />
      {/* Keyed so each new word fades in and starts its shimmer from the left. */}
      <span key={word} className="thinking-word" aria-hidden="true">
        {word}
      </span>
      <span className="sr-only">Working…</span>
    </div>
  );
}

/**
 * Twelve rounded rays in two sets of six that grow and shrink in turn while the whole spark turns, so it spins and
 * changes shape at once. styles.css sets its accent color and the motion.
 */
function Spark() {
  const ray = (angle: number) => <line key={angle} x1="12" y1="3" x2="12" y2="21" transform={`rotate(${angle} 12 12)`} />;
  return (
    <svg className="thinking-spark" viewBox="0 0 24 24" aria-hidden="true">
      <g className="thinking-spark-long">{[0, 60, 120].map(ray)}</g>
      <g className="thinking-spark-short">{[30, 90, 150].map(ray)}</g>
    </svg>
  );
}
