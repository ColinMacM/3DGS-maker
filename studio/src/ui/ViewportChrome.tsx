import type { ToolMode, ViewportStatus } from "../domain/types";

interface ViewportToolbarProps {
  mode: ToolMode;
  splatVisible: boolean;
  tableVisible: boolean;
  collisionsVisible: boolean;
  onModeChange(mode: ToolMode): void;
  onView(view: "perspective" | "top" | "front" | "right"): void;
  onFocus(): void;
  onToggleSplat(): void;
  onToggleTable(): void;
  onToggleCollisions(): void;
}

export function ViewportToolbar(props: ViewportToolbarProps) {
  return (
    <div className="viewport-toolbar" aria-label="Viewport controls">
      <div className="viewport-toolbar__group compact-mode-tools">
        {(["select", "translate", "rotate", "measure"] as ToolMode[]).map((mode) => <button key={mode} type="button" aria-pressed={props.mode === mode} className={props.mode === mode ? "is-active" : ""} onClick={() => props.onModeChange(mode)}>{mode === "translate" ? "Move" : mode[0].toUpperCase() + mode.slice(1)}</button>)}
      </div>
      <div className="viewport-toolbar__group view-tools">
        <button type="button" onClick={() => props.onView("perspective")}>Perspective</button>
        <button type="button" onClick={() => props.onView("top")} title="Top view (7)">Top</button>
        <button type="button" onClick={() => props.onView("front")} title="Front view (1)">Front</button>
        <button type="button" onClick={() => props.onView("right")} title="Right view (3)">Right</button>
        <button type="button" onClick={props.onFocus} title="Focus viewport (F)">Focus</button>
      </div>
      <div className="viewport-toolbar__group visibility-tools" aria-label="Scene visibility">
        <button type="button" className={`layer-toggle layer-toggle--splat${props.splatVisible ? " is-active" : ""}`} aria-pressed={props.splatVisible} onClick={props.onToggleSplat} title="Show or hide the captured SPZ"><span aria-hidden="true" />Splat</button>
        <button type="button" className={`layer-toggle layer-toggle--table${props.tableVisible ? " is-active" : ""}`} aria-pressed={props.tableVisible} onClick={props.onToggleTable} title="Show or hide the generated table"><span aria-hidden="true" />Table</button>
        <button type="button" className={`layer-toggle layer-toggle--collisions${props.collisionsVisible ? " is-active" : ""}`} aria-pressed={props.collisionsVisible} onClick={props.onToggleCollisions} title="Show or hide collision proxies"><span aria-hidden="true" />Collisions</button>
      </div>
    </div>
  );
}

interface DatumStripProps {
  status: ViewportStatus;
  measurementMode: boolean;
}

function coordinate(value: number | undefined): string {
  return typeof value === "number" ? value.toFixed(3) : "—";
}

export function DatumStrip({ status, measurementMode }: DatumStripProps) {
  return (
    <div className="datum-strip" aria-label="Datum and viewport status">
      <div className="datum-origin"><span className="datum-cross" aria-hidden="true" />World datum</div>
      <dl className="coordinate-readout">
        <div><dt>X</dt><dd>{coordinate(status.cursor?.[0])}</dd></div>
        <div><dt>Y</dt><dd>{coordinate(status.cursor?.[1])}</dd></div>
        <div><dt>Z</dt><dd>{coordinate(status.cursor?.[2])}</dd></div>
        <div><dt>Units</dt><dd>m</dd></div>
        <div><dt>Up</dt><dd>Z</dd></div>
      </dl>
      <div className={`viewport-message${status.ready ? " is-ready" : ""}`} role="status"><span aria-hidden="true" />{measurementMode ? "Pick two points to measure" : status.message}</div>
    </div>
  );
}

interface StatusBarProps {
  catalogCount: number;
  collisionCount: number;
  referenceCount: number;
  status: ViewportStatus;
}

export function StatusBar(props: StatusBarProps) {
  return (
    <footer className="status-bar">
      <span><i className={props.status.ready ? "health-light is-ready" : "health-light"} />{props.status.ready ? "Renderer ready" : "Renderer starting"}</span>
      <span>{props.catalogCount} local asset{props.catalogCount === 1 ? "" : "s"}</span>
      <span>{props.collisionCount} collision boxes</span>
      <span>{props.referenceCount} reference{props.referenceCount === 1 ? "" : "s"}</span>
      <span className="status-bar__local">Local browser workspace</span>
    </footer>
  );
}
