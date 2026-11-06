import { createContext, useEffect, useRef, type RefObject } from "react";
import { useMediaQuery } from "../layout.tsx";

/**
 * Phones, tablets and narrow windows: messages have no hover bar. A long press (or a right click) opens a message's
 * menu, and dragging the conversation to the left shows when each message was sent. The chat reads it once
 * (useCompact), marks its messages `data-compact` for the styles and hands it down in Compact.
 */
const COMPACT_QUERY = "(hover: none), (max-width: 640px)";

/** Whether the app is compact (COMPACT_QUERY), following the window as it changes. */
export const useCompact = (): boolean => useMediaQuery(COMPACT_QUERY);

/** Whether the chat is compact, for its messages: read once by the chat, not by each of them. */
export const Compact = createContext(false);

/** How long a press is held before it opens the menu, and how far it may wander meanwhile. */
const PRESS_MS = 450;
const SLOP_PX = 10;

/**
 * The click a press or a drag ends in, which would land on whatever is under the finger (the menu that just opened,
 * a button in a message): swallowed, if one comes at once.
 */
function swallowNextClick(): void {
  const stop = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener("click", stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 400);
}

/** Links, buttons and fields in a message keep their own long press (and the browser's menu for a link). */
const OWN_PRESS = "a, button, input, textarea, select, summary";

/**
 * Calls `onPress` with where `target` was pressed, once a finger (or pen) holds it still for a moment, or on a right
 * click (which is also how Android reports a long press). A mouse only right-clicks: holding its button still is
 * how a text selection starts. Only while `on`.
 */
export function useLongPress(target: RefObject<HTMLElement | null>, on: boolean, onPress: (x: number, y: number) => void): void {
  const latest = useRef(onPress);
  latest.current = onPress;
  useEffect(() => {
    const el = target.current;
    if (!on || !el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let start: { x: number; y: number; id: number } | undefined;
    // Whether a press is held (followed on the window), and whether it has opened the menu.
    let held = false;
    let fired = false;
    // Followed on the window while pressed: a drag of the conversation captures the pointer, and its moves never
    // reach the message, but must still cancel the press.
    const cancel = () => {
      clearTimeout(timer);
      start = undefined;
      held = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
    const move = (event: PointerEvent) => {
      if (start?.id === event.pointerId && Math.hypot(event.clientX - start.x, event.clientY - start.y) > SLOP_PX) cancel();
    };
    const up = () => {
      if (fired) swallowNextClick();
      fired = false;
      cancel();
    };
    const down = (event: PointerEvent) => {
      if (!event.isPrimary || event.button !== 0 || event.pointerType === "mouse" || (event.target as Element).closest(OWN_PRESS)) return;
      cancel();
      const at = { x: event.clientX, y: event.clientY, id: event.pointerId };
      start = at;
      held = true;
      fired = false;
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
      timer = setTimeout(() => {
        start = undefined;
        fired = true;
        navigator.vibrate?.(10);
        latest.current(at.x, at.y);
      }, PRESS_MS);
    };
    const menu = (event: MouseEvent) => {
      if ((event.target as Element).closest(OWN_PRESS)) return;
      event.preventDefault();
      // Android reports a long press both ways, in either order: one menu, and the press still ends in a swallowed click.
      // A right click holds no press, and each one opens the menu.
      if (held && fired) return;
      clearTimeout(timer);
      start = undefined;
      fired = held;
      latest.current(event.clientX, event.clientY);
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("contextmenu", menu);
    return () => {
      cancel();
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("contextmenu", menu);
    };
  }, [target, on]);
}

/** Whether `target` is in something under `root` that scrolls sideways (a wide code block or table): a drag there scrolls it. */
function inSideScroller(target: EventTarget | null, root: HTMLElement): boolean {
  for (let node = target instanceof Element ? target : null; node && node !== root; node = node.parentElement) {
    if (node.scrollWidth > node.clientWidth && /auto|scroll/.test(getComputedStyle(node).overflowX)) return true;
  }
  return false;
}

/** How far the conversation moves to the left at most, uncovering the times beside its messages. */
const REVEAL_PX = 72;

/**
 * Dragging the conversation in `list` to the left moves `track` (what the list holds) with the finger, up to
 * REVEAL_PX, showing the times beside its messages; letting go puts it back. A drag that starts up or down is the
 * list's own scroll. Only while `on`.
 */
export function useSwipeReveal(list: RefObject<HTMLElement | null>, track: RefObject<HTMLElement | null>, on: boolean): void {
  useEffect(() => {
    const el = list.current;
    const moved = track.current;
    if (!on || !el || !moved) return;
    let start: { x: number; y: number; id: number } | undefined;
    let axis: "x" | "y" | undefined;
    let shown = 0;
    const reveal = (px: number) => {
      if (px === shown) return;
      shown = px;
      moved.style.transform = px ? `translateX(${-px}px)` : "";
    };
    const down = (event: PointerEvent) => {
      if (!event.isPrimary || event.button !== 0 || inSideScroller(event.target, el)) return;
      start = { x: event.clientX, y: event.clientY, id: event.pointerId };
      axis = undefined;
    };
    const move = (event: PointerEvent) => {
      if (start?.id !== event.pointerId) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (!axis) {
        if (Math.hypot(dx, dy) < SLOP_PX) return;
        axis = dx < 0 && Math.abs(dx) > Math.abs(dy) ? "x" : "y";
        if (axis === "x") {
          moved.classList.add("revealing");
          el.setPointerCapture(event.pointerId);
          getSelection()?.removeAllRanges();
        }
      }
      if (axis === "x") reveal(Math.min(REVEAL_PX, Math.max(0, -dx)));
    };
    const end = (event: PointerEvent) => {
      if (start?.id !== event.pointerId) return;
      if (axis === "x") {
        if (event.type === "pointerup") swallowNextClick();
        moved.classList.remove("revealing");
        reveal(0);
      }
      start = undefined;
      axis = undefined;
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
      moved.classList.remove("revealing");
      moved.style.transform = "";
    };
  }, [list, track, on]);
}
