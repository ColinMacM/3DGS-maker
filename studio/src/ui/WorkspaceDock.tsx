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
  onAddReference(): void;
  onLayerChange(layer: keyof LayerVisibility, visible: boolean): void;
  onRemoveReference(id: string): void;
  onRemoveMeasurement(id: string): void;
  onClose(): void;
}

const layerLabels: Record<keyof LayerVisibility, string> = {
  catalogVisuals: "Captured splat",
  parametricModel: "Generated table",
  collisions: "Collision proxies",
  reference: "Local references",
  measurements: "Measurements",
};

function measurementDistance(measurement: Measurement): number {
  const dx = measurement.end[0] - measurement.start[0];
  const dy = measurement.end[1] - measurement.start[1];
  const dz = measurement.end[2] - measurement.start[2];
  return Math.hypot(dx, dy, dz);
}

export function WorkspaceDock(props: WorkspaceDockProps) {
  return (
    <aside className={`workspace-dock${props.open ? " is-open" : ""}`} aria-label="Catalog and scene">
      <div className="panel-topline">
        <div className="segmented-tabs" role="tablist" aria-label="Workspace">
          <button type="button" role="tab" aria-selected={props.tab === "catalog"} onClick={() => props.onTabChange("catalog")}>Catalog</button>
          <button type="button" role="tab" aria-selected={props.tab === "scene"} onClick={() => props.onTabChange("scene")}>Scene</button>
        </div>
        <button className="drawer-close" type="button" onClick={props.onClose} aria-label="Close catalog and scene panel">×</button>
      </div>

      {props.tab === "catalog" ? (
        <div className="dock-scroll" role="tabpanel" aria-label="Catalog">
          <div className="panel-section-heading">
            <div><h2>Local assets</h2><p>Metric, Z-up environments</p></div>
            <span className="count-badge">{props.catalog.length}</span>
          </div>
          {props.catalogLoading && <div className="loading-state"><span className="loading-rule" />Reading local catalog…</div>}
          {props.catalogError && (
            <div className="inline-message inline-message--error" role="alert">
              <strong>Catalog unavailable</strong>
              <p>{props.catalogError}</p>
              <button type="button" onClick={props.onRetryCatalog}>Retry catalog</button>
            </div>
          )}
          {!props.catalogLoading && !props.catalogError && props.catalog.length === 0 && (
            <div className="empty-state"><strong>No local assets found</strong><p>Add an asset descriptor to catalog.json, then retry.</p><button type="button" onClick={props.onRetryCatalog}>Retry catalog</button></div>
          )}
          <div className="catalog-list">
            {props.catalog.map((asset) => (
              <article className={`catalog-entry${asset.id === props.activeAssetId && asset.version === props.activeAssetVersion ? " is-current" : ""}`} key={`${asset.id}:${asset.version}`}>
                <div className="catalog-entry__diagram" aria-hidden="true"><span /><span /><span /></div>
                <div>
                  <div className="catalog-entry__title"><h3>{asset.name}</h3>{asset.id === props.activeAssetId && asset.version === props.activeAssetVersion && <span>Active</span>}</div>
                  <p>{asset.description}</p>
                  <dl><div><dt>Units</dt><dd>metres</dd></div><div><dt>Axis</dt><dd>Z-up</dd></div><div><dt>Version</dt><dd>{asset.version}</dd></div></dl>
                </div>
              </article>
            ))}
          </div>
          <div className="asset-boundary-note"><span aria-hidden="true">ⓘ</span><p><strong>Environment only.</strong> Robot composition and controllers belong downstream in the simulator project.</p></div>
        </div>
      ) : (
        <div className="dock-scroll" role="tabpanel" aria-label="Scene">
          <div className="panel-section-heading"><div><h2>Scene layers</h2><p>Visibility and local data</p></div></div>
          <ul className="layer-list">
            {(Object.keys(layerLabels) as Array<keyof LayerVisibility>).map((layer) => (
              <li key={layer}>
                <label>
                  <input type="checkbox" checked={props.layers[layer]} onChange={(event) => props.onLayerChange(layer, event.target.checked)} />
                  <span className={`layer-symbol layer-symbol--${layer}`} aria-hidden="true" />
                  <span>{layerLabels[layer]}</span>
                </label>
              </li>
            ))}
          </ul>

          <div className="scene-group">
            <div className="scene-group__heading"><h3>References</h3><button type="button" onClick={props.onAddReference}>Add</button></div>
            {props.references.length === 0 ? <p className="small-empty">No scan or mesh reference. Add a local PLY, SPLAT, KSPLAT, SPZ, GLB, or OBJ file.</p> : (
              <ul className="object-list">
                {props.references.map((reference) => {
                  const availability = getReferenceAvailability(reference);
                  const unavailable = availability.state === "unavailable";
                  return (
                    <li key={reference.id} className={unavailable ? "is-unavailable" : ""}>
                      <span className="object-kind">{reference.kind === "mesh" ? "Mesh" : "Scan"}</span>
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
