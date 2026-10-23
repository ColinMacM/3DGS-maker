import { useState } from "react";
import type { LayerVisibility, TableParameters, Transform } from "../domain/types";
import { NumericField } from "./NumericField";

interface InspectorPanelProps {
  open: boolean;
  table: TableParameters;
  transform: Transform;
  layers: LayerVisibility;
  onTableChange(patch: Partial<TableParameters>): void;
  onTransformChange(transform: Transform): void;
  onLayerChange(layer: keyof LayerVisibility, visible: boolean): void;
  onClose(): void;
}

const layerRows: Array<[keyof LayerVisibility, string, string]> = [
  ["catalogVisuals", "Catalog scan + model", "SPZ scan and fullbright GLB"],
  ["parametricModel", "Parametric model", "Editable table"],
  ["collisions", "Collision proxies", "Simulator geometry"],
  ["reference", "References", "Local files"],
  ["measurements", "Measurements", "Viewport annotations"],
];

export function InspectorPanel(props: InspectorPanelProps) {
  const [transformError, setTransformError] = useState("");
  const setPosition = (axis: 0 | 1 | 2, value: number) => {
    const position: [number, number, number] = [...props.transform.position];
    position[axis] = value;
    setTransformError("");
    props.onTransformChange({ ...props.transform, position });
  };
  const setQuaternion = (axis: 0 | 1 | 2 | 3, value: number) => {
    const quaternionXyzw: [number, number, number, number] = [...props.transform.quaternionXyzw];
    quaternionXyzw[axis] = value;
    if (quaternionXyzw.every((component) => component === 0)) {
      setTransformError("Quaternion cannot be all zero. Enter at least one non-zero component.");
      return;
    }
    setTransformError("");
    props.onTransformChange({ ...props.transform, quaternionXyzw });
  };
  const setScale = (axis: 0 | 1 | 2, value: number) => {
    const scale: [number, number, number] = [...props.transform.scale];
    scale[axis] = value;
    setTransformError("");
    props.onTransformChange({ ...props.transform, scale });
  };

  return (
    <aside className={`inspector-panel${props.open ? " is-open" : ""}`} aria-label="Inspector">
      <div className="panel-titlebar"><div><h2>Inspector</h2><p>Parametric welding table</p></div><button className="drawer-close" type="button" onClick={props.onClose} aria-label="Close inspector">×</button></div>
      <div className="inspector-scroll">
        <details className="inspector-section" open>
          <summary><span>Table dimensions</span><span className="summary-value">metres</span></summary>
          <div className="inspector-section__body field-grid">
            <NumericField label="Width" value={props.table.width} min={0.2} max={5} step={0.001} unit="m" onCommit={(width) => props.onTableChange({ width })} />
            <NumericField label="Length" value={props.table.length} min={0.2} max={10} step={0.001} unit="m" onCommit={(length) => props.onTableChange({ length })} />
            <NumericField label="Top thickness" value={props.table.topThickness} min={0.005} max={0.5} step={0.001} unit="m" onCommit={(topThickness) => props.onTableChange({ topThickness })} />
            <NumericField label="Top elevation" value={props.table.topHeight} min={0.1} max={3} step={0.001} unit="m" onCommit={(topHeight) => props.onTableChange({ topHeight })} />
            <NumericField label="Leg size" value={props.table.legSize} min={0.01} max={0.5} step={0.001} unit="m" onCommit={(legSize) => props.onTableChange({ legSize })} />
          </div>
        </details>

        <details className="inspector-section" open>
          <summary><span>Hole grid</span><span className="summary-value">through holes</span></summary>
          <div className="inspector-section__body field-grid">
            <NumericField label="Hole diameter" value={props.table.holeDiameter} min={0.001} max={Math.min(0.2, props.table.holePitch * 0.95)} step={0.0001} unit="m" onCommit={(holeDiameter) => props.onTableChange({ holeDiameter })} />
            <NumericField label="Hole pitch" value={props.table.holePitch} min={Math.max(0.005, props.table.holeDiameter * 1.05)} max={0.5} step={0.0001} unit="m" onCommit={(holePitch) => props.onTableChange({ holePitch })} />
            <NumericField label="Rows" value={props.table.rows} min={1} max={100} step={1} integer onCommit={(rows) => props.onTableChange({ rows })} />
            <NumericField label="Columns" value={props.table.columns} min={1} max={100} step={1} integer onCommit={(columns) => props.onTableChange({ columns })} />
            <NumericField label="Edge to first center" value={props.table.edgeToHole} min={0} max={Math.min(props.table.width, props.table.length) / 2} step={0.001} unit="m" onCommit={(edgeToHole) => props.onTableChange({ edgeToHole })} />
          </div>
        </details>

        <details className="inspector-section" open>
          <summary><span>Transform</span><span className="summary-value">Z-up · XYZW</span></summary>
          <div className="inspector-section__body">
            <h3>Position</h3>
            <div className="axis-grid">
              {(["X", "Y", "Z"] as const).map((axis, index) => <NumericField key={axis} label={axis} value={props.transform.position[index]} min={-1000} max={1000} step={0.001} unit="m" onCommit={(value) => setPosition(index as 0 | 1 | 2, value)} />)}
            </div>
            <h3>Quaternion</h3>
            <div className="quaternion-grid">
              {(["X", "Y", "Z", "W"] as const).map((axis, index) => <NumericField key={axis} label={axis} value={props.transform.quaternionXyzw[index]} min={-1} max={1} step={0.001} onCommit={(value) => setQuaternion(index as 0 | 1 | 2 | 3, value)} />)}
            </div>
            <p className={transformError ? "section-help section-help--error" : "section-help"} role={transformError ? "alert" : undefined}>{transformError || "Quaternion order is XYZW in the scene document."}</p>
            <h3>Scale</h3>
            <div className="axis-grid">
              {(["X", "Y", "Z"] as const).map((axis, index) => <NumericField key={axis} label={axis} value={props.transform.scale[index]} min={0.001} max={100} step={0.01} onCommit={(value) => setScale(index as 0 | 1 | 2, value)} />)}
            </div>
          </div>
        </details>

        <details className="inspector-section">
          <summary><span>Layer display</span><span className="summary-value">{layerRows.filter(([key]) => props.layers[key]).length} visible</span></summary>
          <div className="inspector-section__body display-list">
            {layerRows.map(([key, label, description]) => <label key={key}><span><strong>{label}</strong><small>{description}</small></span><input type="checkbox" checked={props.layers[key]} onChange={(event) => props.onLayerChange(key, event.target.checked)} /></label>)}
          </div>
        </details>
      </div>
    </aside>
  );
}
