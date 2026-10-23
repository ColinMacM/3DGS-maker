import { getReferenceAvailability } from "../domain/referenceAvailability";
import type { CatalogEntry, LayerVisibility, Measurement, ReferenceLayer } from "../domain/types";

export type DockTab = "catalog" | "scene";

interface WorkspaceDockProps {
  open: boolean;
  tab: DockTab;
  catalog: CatalogEntry[];
  activeAssetId: string;
  activeAssetVersion: string;
  catalogLoading: boolean;
  catalogError: string;
  layers: LayerVisibility;
  references: ReferenceLayer[];
  measurements: Measurement[];
  onTabChange(tab: DockTab): void;
  onRetryCatalog(): void;
  onSelectAsset(assetId: string, assetVersion: string): void;
  onAddReference(): void;
  onLayerChange(layer: keyof LayerVisibility, visible: boolean): void;
  onRemoveReference(id: string): void;
  onRemoveMeasurement(id: string): void;
  onClose(): void;
}

/** Display label and the API layer it maps to; `catalogVisuals` is the package's source splat, not its GLB. */
const layerLabels: Record<keyof LayerVisibility, { label: string; detail: string }> = {
  catalogVisuals: { label: "Source splat", detail: "Package Gaussian splat" },
  assetVisuals: { label: "3D asset", detail: "Scene objects; the package GLB shows only while no object is visible" },
  collisions: { label: "Collision geometry", detail: "Authored colliders, or the package colliders when none are authored" },
  reference: { label: "Local sources", detail: "Imported splats and meshes" },
  measurements: { label: "Measurements", detail: "Measurements and agent overlays" },
};

function measurementDistance(measurement: Measurement): number {
  const dx = measurement.end[0] - measurement.start[0];
  const dy = measurement.end[1] - measurement.start[1];
  const dz = measurement.end[2] - measurement.start[2];
  return Math.hypot(dx, dy, dz);
}

export function WorkspaceDock(props: WorkspaceDockProps) {
  return (
    <aside className={`workspace-dock${props.open ? " is-open" : ""}`} aria-label="Assets and scene">
      <div className="panel-topline">
        <div className="segmented-tabs" role="tablist" aria-label="Workspace">
          <button type="button" role="tab" aria-selected={props.tab === "catalog"} onClick={() => props.onTabChange("catalog")}>Assets</button>
          <button type="button" role="tab" aria-selected={props.tab === "scene"} onClick={() => props.onTabChange("scene")}>Scene</button>
        </div>
        <button className="drawer-close" type="button" onClick={props.onClose} aria-label="Close assets and scene panel">×</button>
      </div>

      {props.tab === "catalog" ? (
        <div className="dock-scroll" role="tabpanel" aria-label="Assets">
          <div className="panel-section-heading">
            <div><h2>Asset packages</h2><p>Splat, mesh, and target outputs</p></div>
            <span className="count-badge">{props.catalog.length}</span>
          </div>
          {props.catalogLoading && <div className="loading-state"><span className="loading-rule" />Reading asset packages…</div>}
          {props.catalogError && (
            <div className="inline-message inline-message--error" role="alert">
              <strong>Asset packages unavailable</strong>
              <p>{props.catalogError}</p>
              <button type="button" onClick={props.onRetryCatalog}>Retry</button>
            </div>
          )}
          {!props.catalogLoading && !props.catalogError && props.catalog.length === 0 && (
            <div className="empty-state"><strong>No asset packages found</strong><p>Add an asset descriptor to catalog.json, then retry.</p><button type="button" onClick={props.onRetryCatalog}>Retry</button></div>
          )}
          <div className="catalog-list">
            {props.catalog.map((asset) => (
              <button
                type="button"
                className={`catalog-entry${asset.id === props.activeAssetId && asset.version === props.activeAssetVersion ? " is-current" : ""}`}
                key={`${asset.id}:${asset.version}`}
                aria-pressed={asset.id === props.activeAssetId && asset.version === props.activeAssetVersion}
                onClick={() => props.onSelectAsset(asset.id, asset.version)}
              >
                <span className="catalog-entry__diagram" aria-hidden="true"><span /><span /><span /></span>
                <span>
                  <span className="catalog-entry__title"><strong>{asset.name}</strong>{asset.id === props.activeAssetId && asset.version === props.activeAssetVersion && <span>Active</span>}</span>
                  <span className="catalog-entry__description">{asset.description}</span>
                  <span className="catalog-entry__facts"><span>metres</span><span>Z-up</span><span>{asset.version}</span></span>
                </span>
              </button>
            ))}
          </div>
          <div className="asset-boundary-note"><span aria-hidden="true">ⓘ</span><p><strong>One package, three targets.</strong> Keep the source splat, generated mesh, collision data, and simulator exports aligned.</p></div>
        </div>
      ) : (
        <div className="dock-scroll" role="tabpanel" aria-label="Scene">
          <div className="panel-section-heading"><div><h2>Scene layers</h2><p>Source, asset, and review data</p></div></div>
          <ul className="layer-list">
            {(Object.keys(layerLabels) as Array<keyof LayerVisibility>).map((layer) => (
              <li key={layer}>
                <label title={`${layerLabels[layer].detail} (layer "${layer}")`}>
                  <input type="checkbox" checked={props.layers[layer]} onChange={(event) => props.onLayerChange(layer, event.target.checked)} />
                  <span className={`layer-symbol layer-symbol--${layer}`} aria-hidden="true" />
                  <span>{layerLabels[layer].label}</span>
                </label>
              </li>
            ))}
          </ul>

          <div className="scene-group">
            <div className="scene-group__heading"><h3>Source files</h3><button type="button" onClick={props.onAddReference}>Add</button></div>
            {props.references.length === 0 ? <p className="small-empty">Add a local PLY, SPLAT, KSPLAT, SPZ, GLB, or OBJ source.</p> : (
              <ul className="object-list">
                {props.references.map((reference) => {
                  const availability = getReferenceAvailability(reference);
                  const unavailable = availability.state === "unavailable";
                  return (
                    <li key={reference.id} className={unavailable ? "is-unavailable" : ""}>
                      <span className="object-kind">{reference.kind === "mesh" ? "Mesh" : "Splat"}</span>
                      <span title={unavailable ? availability.reason : reference.name}>
                        {reference.name}
                        {unavailable && <small>Unavailable · re-import the local file</small>}
                      </span>
                      <button type="button" onClick={() => props.onRemoveReference(reference.id)} aria-label={`Remove ${reference.name}`}>×</button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="scene-group">
            <div className="scene-group__heading"><h3>Measurements</h3><span className="count-badge">{props.measurements.length}</span></div>
            {props.measurements.length === 0 ? <p className="small-empty">Choose Measure, then pick two points in the viewport.</p> : (
              <ul className="measurement-list">
                {props.measurements.map((measurement) => <li key={measurement.id}><div><strong>{measurement.label}</strong><span>{(measurementDistance(measurement) * 1000).toFixed(2)} mm</span></div><button type="button" onClick={() => props.onRemoveMeasurement(measurement.id)} aria-label={`Remove ${measurement.label}`}>×</button></li>)}
              </ul>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
