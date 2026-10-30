import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Icon } from "../Icon.tsx";
import { useStoredState } from "../layout.tsx";

/** A page size, in CSS pixels. A preset without a height is as tall as the pane allows, like a browser window, and cannot turn. */
interface Size {
  width: number;
  height?: number;
}

interface Preset {
  label: string;
  size?: Size;
  icon: ReactNode;
}

const deviceIcon = (x: number, width: number) => (
  <>
    <rect x={x} y="1.5" width={width} height="13" rx="1.5" />
    <path d="M7 12.5h2" />
  </>
);

/** In picker order. Fit has no size: the page fills the pane. 768 and 1024 (the tablet turned) sit on the usual md and lg breakpoints. */
const PRESETS = {
  fit: { label: "Fit the pane", icon: <path d="M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3" /> },
  mobile: { label: "Mobile", size: { width: 390, height: 844 }, icon: deviceIcon(4.5, 7) },
  tablet: { label: "Tablet", size: { width: 768, height: 1024 }, icon: deviceIcon(2.5, 11) },
  desktop: {
    label: "Desktop",
    size: { width: 1440 },
    icon: (
      <>
        <rect x="1.5" y="2.5" width="13" height="8.5" rx="1" />
        <path d="M6 14h4M8 11v3" />
      </>
    ),
  },
} satisfies Record<string, Preset>;

export type ViewportId = keyof typeof PRESETS;

const VIEWPORT_IDS = Object.keys(PRESETS) as ViewportId[];

function sizeOf(id: ViewportId): Size | undefined {
  return (PRESETS[id] as Preset).size;
}

export function isViewportId(value: unknown): value is ViewportId {
  return VIEWPORT_IDS.includes(value as ViewportId);
}

const canTurn = (id: ViewportId) => sizeOf(id)?.height !== undefined;

/** The picked size and whether it is turned, remembered in this browser. A newly picked device starts upright. */
export function useViewport() {
  const [id, setId] = useStoredState<ViewportId>("preview.viewport", "fit", isViewportId);
  const [rotated, setRotated] = useStoredState("preview.rotated", false, (value): value is boolean => typeof value === "boolean");
  return {
    id,
    rotated: rotated && canTurn(id),
    pick: (next: ViewportId) => {
      if (next !== id) setRotated(false);
      setId(next);
    },
    turn: () => setRotated(!rotated),
  };
}

/** Room left around a device so its edge shows, and under it for the size label. */
const PAD = 16;
const LABEL = 24;

interface Layout {
  /** The page's viewport, in CSS pixels. */
  width: number;
  height: number;
  /** Shrinks the viewport to fit the pane; never enlarges it. */
  scale: number;
}

/** Where the page goes in a pane of the given size; null means it simply fills the pane. */
export function layoutViewport(id: ViewportId, rotated: boolean, pane: { width: number; height: number }): Layout | null {
  const size = sizeOf(id);
  if (!size || pane.width <= 0 || pane.height <= 0) return null;
  const roomW = Math.max(1, pane.width - 2 * PAD);
  const roomH = Math.max(1, pane.height - 2 * PAD - LABEL);
  if (size.height === undefined) {
    const scale = Math.min(1, roomW / size.width);
    return { width: size.width, height: Math.floor(roomH / scale), scale };
  }
  const [width, height] = rotated ? [size.height, size.width] : [size.width, size.height];
  return { width, height, scale: Math.min(1, roomW / width, roomH / height) };
}

/** The preview bar's icons, drawn in a 16-unit box. */
function PreviewIcon({ children }: { children: ReactNode }) {
  return (
    <Icon size={15} box={16} stroke={1.4}>
      {children}
    </Icon>
  );
}

/** Fit, mobile, tablet or desktop, plus a turn button for the sizes with a portrait shape. */
export function ViewportPicker({ viewport }: { viewport: ReturnType<typeof useViewport> }) {
  return (
    <div className="viewport-picker" role="group" aria-label="Preview size">
      {VIEWPORT_IDS.map((id) => {
        const size = sizeOf(id);
        const label = size ? `${PRESETS[id].label} (${size.width}px wide)` : PRESETS[id].label;
        return (
          <button key={id} type="button" aria-pressed={viewport.id === id} title={label} aria-label={label} onClick={() => viewport.pick(id)}>
            <PreviewIcon>{PRESETS[id].icon}</PreviewIcon>
          </button>
        );
      })}
      {canTurn(viewport.id) && (
        <button type="button" aria-pressed={viewport.rotated} title="Turn the device" aria-label="Turn the device" onClick={viewport.turn}>
          <PreviewIcon>
            <rect x="1.5" y="8" width="9.5" height="6.5" rx="1.2" />
            <path d="M5 4.5a3.5 3.5 0 0 1 3.5-3h1a4 4 0 0 1 4 4V7" />
            <path d="M11.5 5.5l2 2 2-2" />
          </PreviewIcon>
        </button>
      )}
    </div>
  );
}

/**
 * The preview area. At a device size the page gets that viewport, so its media queries
 * react as on the device, and is scaled down when the pane is smaller. The tree is the
 * same in every mode, so switching resizes the frame without reloading the page.
 */
export function ViewportStage({ id, rotated, children }: { id: ViewportId; rotated: boolean; children: ReactNode }) {
  const stage = useRef<HTMLDivElement>(null);
  const [pane, setPane] = useState({ width: 0, height: 0 });
  const fit = sizeOf(id) === undefined;

  // Only a device size needs the pane's size, so dragging a column in fit mode renders nothing extra.
  // The pane is measured here too, before paint: the size kept from the last device mode may be stale,
  // and the observer's first report only re-renders after a frame at that size has been painted.
  useLayoutEffect(() => {
    if (fit) return;
    const el = stage.current!;
    const measure = (width: number, height: number) =>
      setPane((old) => (old.width === width && old.height === height ? old : { width, height }));
    measure(el.clientWidth, el.clientHeight);
    const observer = new ResizeObserver(([entry]) => measure(Math.round(entry.contentRect.width), Math.round(entry.contentRect.height)));
    observer.observe(el);
    return () => observer.disconnect();
  }, [fit]);

  const layout = layoutViewport(id, rotated, pane);
  return (
    <div ref={stage} className={layout ? "artifact-stage device" : "artifact-stage"}>
      <div
        className="artifact-device"
        style={
          layout
            ? ({
                width: layout.width * layout.scale,
                height: layout.height * layout.scale,
                "--device-w": `${layout.width}px`,
                "--device-h": `${layout.height}px`,
                "--device-scale": layout.scale,
              } as CSSProperties)
            : undefined
        }
      >
        {children}
      </div>
      {layout && (
        <small className="artifact-size">
          {layout.width} × {layout.height}
          {layout.scale < 1 ? ` · ${Math.round(layout.scale * 100)}%` : ""}
        </small>
      )}
    </div>
  );
}
