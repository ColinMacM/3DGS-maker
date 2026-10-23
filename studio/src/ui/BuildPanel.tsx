import type { BuildResult, BuildTarget } from "../domain/types";

interface BuildPanelProps {
  open: boolean;
  activeTarget: BuildTarget | null;
  result: BuildResult | null;
  error: string;
  onBuild(target: BuildTarget): void;
  onCancel(): void;
  onClose(): void;
}

const targets: Array<{ id: BuildTarget; title: string; artifact: string; detail: string }> = [
  { id: "isaac", title: "Isaac Sim", artifact: ".usdc", detail: "Build a metric OpenUSD stage with collision data." },
  { id: "mujoco", title: "MuJoCo", artifact: ".xml", detail: "Build and smoke-test the MJCF asset." },
  { id: "unreal", title: "Unreal Engine", artifact: ".glb", detail: "Build the mesh package for Unreal import." },
];

export function BuildPanel(props: BuildPanelProps) {
  return (
    <aside className={`build-panel${props.open ? " is-open" : ""}`} aria-label="Export asset">
      <div className="panel-titlebar"><div><h2>Export asset</h2><p>Three simulation targets</p></div><button className="drawer-close" type="button" onClick={props.onClose} aria-label="Close export panel">×</button></div>
      <div className="build-panel__body">
        <div className="validation-summary">
          <span className="validation-icon" aria-hidden="true">✓</span>
          <div><strong>Package export</strong><p>Exports the selected catalog package from its manifest. Scene objects and authored colliders are not exported.</p></div>
        </div>
        <div className="build-targets">
          {targets.map((target) => {
            const running = props.activeTarget === target.id;
            return <section key={target.id} className={running ? "build-target is-running" : "build-target"}>
              <div><h3>{target.title}<span>{target.artifact}</span></h3><p>{target.detail}</p></div>
              <button type="button" disabled={props.activeTarget !== null} onClick={() => props.onBuild(target.id)}>{running ? "Building…" : `Build ${target.title}`}</button>
            </section>;
          })}
        </div>
        {props.activeTarget && <button className="secondary-wide" type="button" onClick={props.onCancel}>Cancel build request</button>}
        {props.error && <div className="inline-message inline-message--error" role="alert"><strong>Build did not start</strong><p>{props.error}</p></div>}
        {props.result && (
          <div className={`build-result${props.result.ok ? " build-result--success" : " build-result--error"}`} aria-live="polite">
            <strong>{props.result.ok ? `${props.result.target} build complete` : `${props.result.target} build failed`}</strong>
            <p>Package <code>{props.result.assetId}</code> from <code>{props.result.packageDirectory}</code> (manifest only; scene objects not exported).</p>
            {props.result.artifact && <p>Artifact: <code>{props.result.artifact}</code></p>}
            <details><summary>Build output</summary><pre>{props.result.output || "The exporter returned no output."}</pre></details>
          </div>
        )}
      </div>
    </aside>
  );
}
