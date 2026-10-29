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
 * Pulsing dots and a rotating status word with a shimmer. Screen readers hear "Working" once, not every word;
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
      <span className="thinking-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {/* Keyed so each new word fades in and starts its shimmer from the left. */}
      <span key={word} className="thinking-word" aria-hidden="true">
        {word}
      </span>
      <span className="sr-only">Working…</span>
    </div>
  );
}
