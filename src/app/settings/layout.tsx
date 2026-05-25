import type { ReactNode } from "react";

/**
 * Settings layout. Paints a full-bleed atmospheric backdrop behind the
 * page content — warm parchment radial at top-left, cool slate radial
 * at bottom-right over a near-base canvas. Scoped to /settings so the
 * rest of the dashboard keeps its flat surface. See `.settings-gradient`
 * in globals.css for the actual color stops (light + dark).
 */
export default function SettingsLayout({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  return (
    <>
      <div
        aria-hidden="true"
        className="settings-gradient pointer-events-none fixed inset-0 -z-10"
      />
      {children}
    </>
  );
}
