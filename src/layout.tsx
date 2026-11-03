import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { Icon } from "./Icon.tsx";

/**
 * A layout setting kept in this browser. Storage can be missing or throw (private windows), or hold
 * a value `valid` rejects (an older build's); the default then applies.
 */
export function useStoredState<T>(key: string, fallback: T, valid?: (value: unknown) => value is T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored === null) return fallback;
      const parsed: unknown = JSON.parse(stored);
      return !valid || valid(parsed) ? (parsed as T) : fallback;
    } catch {
      return fallback;
    }
  });
  const store = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Not remembered; the layout still changes.
      }
    },
    [key],
  );
  return [value, store];
}

/**
 * Closes a popup on a click outside the element the returned ref is put on (an iframe's included), or on Escape;
 * listens only while `open`.
 */
export function useDismiss<T extends HTMLElement>(open: boolean, setOpen: (open: boolean) => void) {
  const box = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => box.current?.contains(event.target as Node) || setOpen(false);
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Focus inside the popup would fall to the page as it closes: hand it back to the button that opened it.
      if (box.current?.contains(document.activeElement)) box.current.querySelector<HTMLElement>("[aria-expanded]")?.focus();
      setOpen(false);
    };
    // A click into an iframe (the artifact preview) reaches no document listener here, but blurs the window.
    const onBlur = () => setOpen(false);
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, [open, setOpen]);
  return box;
}

/** The check for a stored open/closed (or on/off) setting. */
export const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

/**
 * The heading of a sidebar section that opens and closes: its name and count, then whatever else it shows (an
 * indicator while closed), then a chevron pointing the way the section opens, flipped while it is open.
 */
export function SectionHead({
  name,
  count,
  open,
  onToggle,
  upward = false,
  children,
}: {
  name: string;
  count: number;
  open: boolean;
  onToggle: (open: boolean) => void;
  /** The section opens above its heading (a panel at the bottom of the sidebar). */
  upward?: boolean;
  children?: ReactNode;
}) {
  // In a heading, so moving through the page by headings still finds the section.
  return (
    <h3 className="section-title">
      <button
        type="button"
        className="section-head"
        aria-expanded={open}
        onClick={() => onToggle(!open)}
        title={`${open ? "Hide" : "Show"} your ${name.toLowerCase()}`}
      >
        {name} <small>{count.toLocaleString("en")}</small>
        {children}
        <Icon size={14} box={16} stroke={1.8}>
          <path d={upward ? "M4 10l4-4 4 4" : "M4 6l4 4 4-4"} />
        </Icon>
      </button>
    </h3>
  );
}

interface HandleProps {
  label: string;
  /** The width of the column left of the handle, in pixels. */
  width: number;
  min: number;
  /** Computed when the drag starts, so it follows the window size. */
  max: () => number;
  onResize: (width: number) => void;
  onReset: () => void;
  disabled?: boolean;
}

/**
 * The bar between two columns: drag it, or focus it and use the arrow keys.
 * Double-click restores the default. While dragging, the body gets a class
 * that stops iframes (the artifact preview) from swallowing the pointer.
 */
export function ResizeHandle({ label, width, min, max, onResize, onReset, disabled }: HandleProps) {
  const drag = useRef<{ x: number; width: number; max: number } | null>(null);
  const clamp = (value: number, upper: number) => Math.round(Math.min(Math.max(value, min), Math.max(min, upper)));

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width, max: max() };
    document.body.classList.add("resizing");
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (start) onResize(clamp(start.width + event.clientX - start.x, start.max));
  };
  const end = () => {
    drag.current = null;
    document.body.classList.remove("resizing");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16;
    if (event.key === "ArrowLeft") onResize(clamp(width - step, max()));
    else if (event.key === "ArrowRight") onResize(clamp(width + step, max()));
    else if (event.key === "Home") onResize(min);
    else if (event.key === "Enter") onReset();
    else return;
    event.preventDefault();
  };

  return (
    <div
      className={disabled ? "resize-handle disabled" : "resize-handle"}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      tabIndex={disabled ? -1 : 0}
      title={disabled ? undefined : `${label}: drag, or use the arrow keys. Double-click to reset.`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={disabled ? undefined : onReset}
      onKeyDown={disabled ? undefined : onKeyDown}
    />
  );
}
