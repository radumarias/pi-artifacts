import type { ReactNode } from "react";

/** A line icon in the text color. The preview bar draws in a 16-unit box at 15px; the composer in a 24-unit box at 20px. */
export function Icon({ children, size = 20, box = 24, stroke = 1.8 }: { children: ReactNode; size?: number; box?: number; stroke?: number }) {
  return (
    <svg viewBox={`0 0 ${box} ${box}`} width={size} height={size} fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

/** A bin: deleting a chat, a file or a folder. */
export const TrashIcon = ({ stroke }: { stroke?: number }) => (
  <Icon size={15} stroke={stroke}>
    <path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
  </Icon>
);
