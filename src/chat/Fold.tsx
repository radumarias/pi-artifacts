import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { ItemRef } from "../../shared/items.ts";

/** How tall a folded reply shows, in CSS pixels: some twelve lines of text. */
export const FOLD_PX = 320;
/** How much taller than FOLD_PX a reply must be to fold: folding away a line or two would only add a click. */
const FOLD_SLACK = 1.4;

/** Whether a reply this tall (its content's height, in CSS pixels) folds behind "Show more". */
export function folds(height: number): boolean {
  return height > FOLD_PX * FOLD_SLACK;
}

/** The replies the reader unfolded, by chat and key: one stays open when it remounts (a socket's new snapshot draws it again). */
const unfolded = new Set<string>();

/** The chat a Fold's key is named in: entry ids count from 1 in each chat. */
export const FoldScope = createContext("");

/**
 * A long reply, folded to FOLD_PX with "Show more" under it, so a busy chat stays readable; "Show less" folds it again.
 * Measured as it renders and whenever it resizes (a narrower window makes it taller). `foldKey` names the reply.
 */
export function Fold({ foldKey: key, children }: { foldKey: string; children: ReactNode }) {
  const foldKey = `${useContext(FoldScope)}:${key}`;
  const body = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(() => unfolded.has(foldKey));
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const measure = () => setLong(folds(el.scrollHeight));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const folded = long && !open;
  const toggle = () => {
    if (open) unfolded.delete(foldKey);
    else unfolded.add(foldKey);
    setOpen(!open);
  };
  return (
    <div className={folded ? "fold folded" : "fold"}>
      <div className="fold-body" ref={body} style={folded ? { maxHeight: FOLD_PX } : undefined}>
        {children}
      </div>
      {long && (
        <button type="button" className="fold-toggle" onClick={toggle} aria-expanded={open}>
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/**
 * The records a reply is built on, as chips under it: each opens its source item when its server gave a link. They come
 * from what the servers returned (shared/items.ts), never from the reply's text.
 */
export function ItemChips({ items }: { items: readonly ItemRef[] }) {
  if (!items.length) return null;
  return (
    <div className="item-chips" aria-label="Built on">
      {items.map((item) => {
        const key = `${item.server}:${item.id}`;
        const title = `${item.title} · ${item.server} · ${item.id}`;
        return item.url ? (
          <a key={key} className="item-chip" href={item.url} target="_blank" rel="noreferrer noopener" title={title}>
            {item.title}
          </a>
        ) : (
          <span key={key} className="item-chip" title={title}>
            {item.title}
          </span>
        );
      })}
    </div>
  );
}
