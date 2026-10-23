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
  { id: "blender", title: "Blender", artifact: ".blend", detail: "Rebuild the clean environment asset." },
  { id: "openusd", title: "OpenUSD", artifact: ".usdc", detail: "Generate the Isaac-compatible stage." },
  { id: "mujoco", title: "MuJoCo", artifact: ".xml", detail: "Generate and smoke-test the MJCF scene." },
];

export function BuildPanel(props: BuildPanelProps) {
  return (
    <aside className={`build-panel${props.open ? " is-open" : ""}`} aria-label="Build environment">
      <div className="panel-titlebar"><div><h2>Build environment</h2><p>Local whitelisted exporters</p></div><button className="drawer-close" type="button" onClick={props.onClose} aria-label="Close build panel">×</button></div>
      <div className="build-panel__body">
        <div className="validation-summary">
          <span className="validation-icon" aria-hidden="true">✓</span>
          <div><strong>Scene recipe ready</strong><p>Metric coordinates and Z-up frame are preserved.</p></div>
        </div>
        <div className="boundary-warning"><strong>Environment only</strong><p>Add the robot and controllers in the simulator project. Builds never contact hardware.</p></div>
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
            {props.result.artifact && <p>Artifact: <code>{props.result.artifact}</code></p>}
            <details><summary>Build output</summary><pre>{props.result.output || "The exporter returned no output."}</pre></details>
          </div>
        )}
      </div>
    </aside>
  );
}
