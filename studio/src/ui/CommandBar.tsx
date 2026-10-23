import type { ToolMode } from "../domain/types";

interface CommandBarProps {
  projectName: string;
  mode: ToolMode;
  canUndo: boolean;
  canRedo: boolean;
  leftOpen: boolean;
  inspectorOpen: boolean;
  buildOpen: boolean;
  onModeChange(mode: ToolMode): void;
  onUndo(): void;
  onRedo(): void;
  onReset(): void;
  onImportReference(): void;
  onImportScene(): void;
  onExportScene(): void;
  onToggleLeft(): void;
  onToggleInspector(): void;
  onToggleBuild(): void;
}

const modes: Array<{ value: ToolMode; label: string; shortcut: string }> = [
  { value: "select", label: "Select", shortcut: "Q" },
  { value: "translate", label: "Move", shortcut: "W" },
  { value: "rotate", label: "Rotate", shortcut: "E" },
  { value: "measure", label: "Measure", shortcut: "M" },
];

export function CommandBar(props: CommandBarProps) {
  return (
    <header className="command-bar">
      <button className="mobile-panel-button" type="button" aria-expanded={props.leftOpen} onClick={props.onToggleLeft}>
        Catalog and scene
      </button>
      <div className="project-identity">
        <span className="project-mark" aria-hidden="true">W</span>
        <div>
          <strong>{props.projectName}</strong>
          <span><i className="status-dot" /> Saved locally</span>
        </div>
      </div>

      <nav className="mode-tools" aria-label="Viewport tools">
        {modes.map((item) => (
          <button
            key={item.value}
            type="button"
            className={props.mode === item.value ? "is-active" : ""}
            aria-pressed={props.mode === item.value}
            title={`${item.label} (${item.shortcut})`}
            onClick={() => props.onModeChange(item.value)}
          >
            {item.label}
            <kbd>{item.shortcut}</kbd>
          </button>
        ))}
      </nav>

      <div className="command-actions">
        <div className="action-cluster" aria-label="History">
          <button type="button" disabled={!props.canUndo} title="Undo (Ctrl+Z)" onClick={props.onUndo}>Undo</button>
          <button type="button" disabled={!props.canRedo} title="Redo (Ctrl+Shift+Z)" onClick={props.onRedo}>Redo</button>
        </div>
        <details className="file-menu">
          <summary>File</summary>
          <div className="menu-popover">
            <button type="button" onClick={props.onImportReference}>Add local reference…</button>
            <button type="button" onClick={props.onImportScene}>Open scene JSON…</button>
            <button type="button" onClick={props.onExportScene}>Download scene JSON</button>
            <button type="button" className="danger-action" onClick={props.onReset}>Reset scene</button>
          </div>
        </details>
        <button className="mobile-panel-button" type="button" aria-expanded={props.inspectorOpen} onClick={props.onToggleInspector}>Inspect</button>
        <button className={props.buildOpen ? "primary-action is-active" : "primary-action"} type="button" aria-expanded={props.buildOpen} onClick={props.onToggleBuild}>Build</button>
      </div>
    </header>
  );
}
