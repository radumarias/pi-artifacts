import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

export type ViewportId = "fit" | "mobile" | "tablet" | "desktop";

interface Preset {
  label: string;
  width: number;
  /** Omitted for desktop: the page is as tall as the pane allows, like a browser window. */
  height?: number;
}

/** Common CSS viewports. 768 and 1024 (the tablet turned) sit on the usual md and lg breakpoints. */
export const VIEWPORTS: Record<Exclude<ViewportId, "fit">, Preset> = {
  mobile: { label: "Mobile", width: 390, height: 844 },
  tablet: { label: "Tablet", width: 768, height: 1024 },
  desktop: { label: "Desktop", width: 1440 },
};

const VIEWPORT_IDS: ViewportId[] = ["fit", "mobile", "tablet", "desktop"];

export function isViewportId(value: unknown): value is ViewportId {
  return VIEWPORT_IDS.includes(value as ViewportId);
}

/** Room left around a device so its edge shows, and under it for the size label. */
const PAD = 16;
const LABEL = 24;

export interface Layout {
  /** The page's viewport, in CSS pixels. */
  width: number;
  height: number;
  /** Shrinks the viewport to fit the pane; never enlarges it. */
  scale: number;
}

/** Where the page goes in a pane of the given size; null means it simply fills the pane. */
export function layoutViewport(id: ViewportId, rotated: boolean, pane: { width: number; height: number }): Layout | null {
  if (id === "fit" || pane.width <= 0 || pane.height <= 0) return null;
  const preset = VIEWPORTS[id];
  const roomW = Math.max(1, pane.width - 2 * PAD);
  const roomH = Math.max(1, pane.height - 2 * PAD - LABEL);
  if (preset.height === undefined) {
    const scale = Math.min(1, roomW / preset.width);
    return { width: preset.width, height: Math.floor(roomH / scale), scale };
  }
  const [width, height] = rotated ? [preset.height, preset.width] : [preset.width, preset.height];
  return { width, height, scale: Math.min(1, roomW / width, roomH / height) };
}

const ICONS: Record<ViewportId, ReactNode> = {
  fit: <path d="M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3" />,
  mobile: (
    <>
      <rect x="4.5" y="1.5" width="7" height="13" rx="1.5" />
      <path d="M7 12.5h2" />
    </>
  ),
  tablet: (
    <>
      <rect x="2.5" y="1.5" width="11" height="13" rx="1.5" />
      <path d="M7 12.5h2" />
    </>
  ),
  desktop: (
    <>
      <rect x="1.5" y="2.5" width="13" height="8.5" rx="1" />
      <path d="M6 14h4M8 11v3" />
    </>
  ),
};

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

interface PickerProps {
  value: ViewportId;
  onChange: (id: ViewportId) => void;
  rotated: boolean;
  onRotate: () => void;
}

/** Fit, mobile, tablet or desktop, plus a turn button for the two devices with a portrait shape. */
export function ViewportPicker({ value, onChange, rotated, onRotate }: PickerProps) {
  const turnable = value === "mobile" || value === "tablet";
  return (
    <div className="viewport-picker" role="group" aria-label="Preview size">
      {VIEWPORT_IDS.map((id) => {
        const label = id === "fit" ? "Fit the pane" : `${VIEWPORTS[id].label} (${VIEWPORTS[id].width}px wide)`;
        return (
          <button key={id} type="button" aria-pressed={value === id} title={label} aria-label={label} onClick={() => onChange(id)}>
            <Icon>{ICONS[id]}</Icon>
          </button>
        );
      })}
      {turnable && (
        <button type="button" aria-pressed={rotated} title="Turn the device" aria-label="Turn the device" onClick={onRotate}>
          <Icon>
            <rect x="1.5" y="8" width="9.5" height="6.5" rx="1.2" />
            <path d="M5 4.5a3.5 3.5 0 0 1 3.5-3h1a4 4 0 0 1 4 4V7" />
            <path d="M11.5 5.5l2 2 2-2" />
          </Icon>
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

  useLayoutEffect(() => {
    const el = stage.current!;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setPane((old) => (old.width === width && old.height === height ? old : { width, height }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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
