import { useState } from "react";
import type { CatalogEntry, LayerVisibility, SceneEntity, Transform } from "../domain/types";
import { NumericField } from "./NumericField";

interface InspectorPanelProps {
  open: boolean;
  catalog: CatalogEntry | null;
  selectedEntity: SceneEntity | null;
  layers: LayerVisibility;
  onEntityChange(entity: SceneEntity): void;
  onLayerChange(layer: keyof LayerVisibility, visible: boolean): void;
  onClose(): void;
}

const layerRows: Array<[keyof LayerVisibility, string, string]> = [
  ["catalogVisuals", "Source splat", "Package Gaussian splat (catalogVisuals)"],
  ["assetVisuals", "3D asset", "Scene objects; package GLB only while none is visible"],
  ["collisions", "Collision geometry", "Authored colliders replace package colliders"],
  ["reference", "Local sources", "Imported splats and meshes"],
  ["measurements", "Measurements", "Measurements and agent overlays"],
];

export function InspectorPanel(props: InspectorPanelProps) {
  const [transformError, setTransformError] = useState("");
  const updateTransform = (transform: Transform) => {
    if (!props.selectedEntity) return;
    setTransformError("");
    props.onEntityChange({ ...props.selectedEntity, transform });
  };
  const setPosition = (axis: 0 | 1 | 2, value: number) => {
    if (!props.selectedEntity) return;
    const position: [number, number, number] = [...props.selectedEntity.transform.position];
    position[axis] = value;
    updateTransform({ ...props.selectedEntity.transform, position });
  };
  const setQuaternion = (axis: 0 | 1 | 2 | 3, value: number) => {
    if (!props.selectedEntity) return;
    const quaternionXyzw: [number, number, number, number] = [...props.selectedEntity.transform.quaternionXyzw];
    quaternionXyzw[axis] = value;
    if (quaternionXyzw.every((component) => component === 0)) {
      setTransformError("Quaternion cannot be all zero.");
      return;
    }
    updateTransform({ ...props.selectedEntity.transform, quaternionXyzw });
  };
  const setScale = (axis: 0 | 1 | 2, value: number) => {
    if (!props.selectedEntity) return;
    const scale: [number, number, number] = [...props.selectedEntity.transform.scale];
    scale[axis] = value;
    updateTransform({ ...props.selectedEntity.transform, scale });
  };

  return (
    <aside className={`inspector-panel${props.open ? " is-open" : ""}`} aria-label="Inspector">
      <div className="panel-titlebar"><div><h2>Inspector</h2><p>{props.selectedEntity ? props.selectedEntity.name : "Asset package"}</p></div><button className="drawer-close" type="button" onClick={props.onClose} aria-label="Close inspector">×</button></div>
      <div className="inspector-scroll">
        <details className="inspector-section" open>
          <summary><span>Asset</span><span className="summary-value">{props.catalog?.version ?? "unavailable"}</span></summary>
          <div className="inspector-section__body">
            {props.catalog ? (
              <dl className="asset-facts">
                <div><dt>Package</dt><dd>{props.catalog.name}</dd></div>
                <div><dt>Source</dt><dd>{props.catalog.browser.spz ? "Gaussian splat" : "No packaged splat"}</dd></div>
                <div><dt>3D asset</dt><dd>{props.catalog.browser.glb}</dd></div>
                <div><dt>Targets</dt><dd>Isaac Sim · MuJoCo · Unreal</dd></div>
              </dl>
            ) : <p className="section-help">The active asset package is unavailable.</p>}
          </div>
        </details>

        {props.selectedEntity && (
          <details className="inspector-section" open>
            <summary><span>Object transform</span><span className="summary-value">Z-up · XYZW</span></summary>
            <div className="inspector-section__body">
              <label className="visibility-field"><span><strong>Visible</strong><small>{props.selectedEntity.kind}</small></span><input type="checkbox" checked={props.selectedEntity.visible} onChange={(event) => props.onEntityChange({ ...props.selectedEntity!, visible: event.target.checked })} /></label>
              <h3>Position</h3>
              <div className="axis-grid">
                {(["X", "Y", "Z"] as const).map((axis, index) => <NumericField key={axis} label={axis} value={props.selectedEntity!.transform.position[index]} min={-1000} max={1000} step={0.001} unit="m" onCommit={(value) => setPosition(index as 0 | 1 | 2, value)} />)}
              </div>
              <h3>Quaternion</h3>
              <div className="quaternion-grid">
                {(["X", "Y", "Z", "W"] as const).map((axis, index) => <NumericField key={axis} label={axis} value={props.selectedEntity!.transform.quaternionXyzw[index]} min={-1} max={1} step={0.001} onCommit={(value) => setQuaternion(index as 0 | 1 | 2 | 3, value)} />)}
              </div>
              <p className={transformError ? "section-help section-help--error" : "section-help"} role={transformError ? "alert" : undefined}>{transformError || "Quaternion order is XYZW."}</p>
              <h3>Scale</h3>
              <div className="axis-grid">
                {(["X", "Y", "Z"] as const).map((axis, index) => <NumericField key={axis} label={axis} value={props.selectedEntity!.transform.scale[index]} min={0.001} max={100} step={0.01} onCommit={(value) => setScale(index as 0 | 1 | 2, value)} />)}
              </div>
            </div>
          </details>
        )}

        <details className="inspector-section" open>
          <summary><span>Layer display</span><span className="summary-value">{layerRows.filter(([key]) => props.layers[key]).length} visible</span></summary>
          <div className="inspector-section__body display-list">
            {layerRows.map(([key, label, description]) => <label key={key}><span><strong>{label}</strong><small>{description}</small></span><input type="checkbox" checked={props.layers[key]} onChange={(event) => props.onLayerChange(key, event.target.checked)} /></label>)}
          </div>
        </details>
      </div>
    </aside>
  );
}
