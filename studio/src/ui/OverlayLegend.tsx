import { useEffect, useState } from "react";

import type { SceneBounds } from "../domain/types";

const DEFAULT_OVERLAY_COLOR = "#35d7ff";

interface OverlayLegendProps {
  bounds: readonly SceneBounds[];
  onDismiss(): void;
}

/**
 * Lists the unexpired agent overlays with their colours, and removes them all
 * from the scene when dismissed. Re-renders itself when the next overlay expires.
 */
export function OverlayLegend({ bounds, onDismiss }: OverlayLegendProps) {
  const [now, setNow] = useState(() => Date.now());
  const active = bounds.filter(({ expiresAt }) => expiresAt === undefined || Date.parse(expiresAt) > now);
  const nextExpiry = Math.min(
    ...active.flatMap(({ expiresAt }) => (expiresAt === undefined ? [] : [Date.parse(expiresAt)])),
  );

  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return undefined;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, nextExpiry - Date.now()));
    return () => window.clearTimeout(timer);
  }, [nextExpiry]);
  useEffect(() => setNow(Date.now()), [bounds]);

  if (active.length === 0) return null;
  return (
    <div className="overlay-legend" role="status" aria-label="Agent overlay">
      <div className="overlay-legend__heading">
        <strong>Agent overlay</strong>
        <button type="button" onClick={onDismiss} aria-label="Hide agent overlay" title="Remove the agent overlays from the scene">×</button>
      </div>
      <ul>
        {active.map(({ id, label, color }) => (
          <li key={id}>
            <span className="overlay-legend__swatch" style={{ background: color ?? DEFAULT_OVERLAY_COLOR }} aria-hidden="true" />
            <span className="overlay-legend__label">{label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
