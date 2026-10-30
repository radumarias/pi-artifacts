import type { ReactNode } from "react";

/** A line icon in the text color. The preview bar draws in a 16-unit box at 15px; the composer in a 24-unit box at 20px. */
export function Icon({ children, size = 20, box = 24, stroke = 1.8 }: { children: ReactNode; size?: number; box?: number; stroke?: number }) {
  return (
    <svg viewBox={`0 0 ${box} ${box}`} width={size} height={size} fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}
