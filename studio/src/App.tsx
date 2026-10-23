import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { loadCatalog, loadCollisionManifest } from "./api/catalog";
import { requestBuild } from "./api/build-contract";
import { parseStudioDocumentJson, serializeStudioDocument } from "./domain/schema";
import { useSceneControlSync } from "./api/useSceneControlSync";
import type { BuildResult, BuildTarget, CatalogEntry, CollisionBox, LayerVisibility, Measurement, ReferenceLayer, SceneEntity, ToolMode, Transform, ViewPreset, ViewportStatus } from "./domain/types";
import { ThreeViewport, type ThreeViewportHandle } from "./engine/ThreeViewport";
import { hydrateReferenceBlobs, putReferenceBlob } from "./persistence/referenceBlobs";
import { validateReferenceImport } from "./persistence/referenceImport";
import { useStudioState } from "./state/useStudioState";
import { BuildPanel } from "./ui/BuildPanel";
import { CommandBar } from "./ui/CommandBar";
import { InspectorPanel } from "./ui/InspectorPanel";
import { OverlayLegend } from "./ui/OverlayLegend";
import { PipelineStrip } from "./ui/PipelineStrip";
import { DatumStrip, StatusBar, ViewportToolbar } from "./ui/ViewportChrome";
import { WorkspaceDock, type DockTab } from "./ui/WorkspaceDock";

const initialViewportStatus: ViewportStatus = {
  ready: false,
  cursor: null,
  selectedId: null,
  message: "Starting renderer…",
  renderErrors: [],
};

const viewportErrorPattern = /failed|error|unavailable|unsupported|no local source|could not/i;

function safeDownloadName(name: string): string {
  const stem = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${stem || "asset-scene"}.asset.json`;
}

function downloadText(text: string, name: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
}

export function App() {
  const {
    document: studioDocument,
    canUndo,
    canRedo,
    dispatch,
    undo,
    redo,
    replaceDocument,
    hydrateReferences,
    synchronizeDocument,
  } = useStudioState();
  const viewportRef = useRef<ThreeViewportHandle>(null);
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const sceneInputRef = useRef<HTMLInputElement>(null);
  const ownedObjectUrls = useRef(new Set<string>());
  const appMounted = useRef(false);
  const initialReferences = useRef(studioDocument.references);
  const buildAbortRef = useRef<AbortController | null>(null);

  const [mode, setMode] = useState<ToolMode>("select");
  const [dockTab, setDockTab] = useState<DockTab>("catalog");
  const [leftOpen, setLeftOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [buildOpen, setBuildOpen] = useState(false);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState("");
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [manifest, setManifest] = useState<{ collision_boxes: CollisionBox[] } | null>(null);
  const [manifestError, setManifestError] = useState("");
  const [viewportStatus, setViewportStatus] = useState<ViewportStatus>(initialViewportStatus);
  const [dismissedViewportMessage, setDismissedViewportMessage] = useState("");
  const [actionError, setActionError] = useState("");
  const [buildTarget, setBuildTarget] = useState<BuildTarget | null>(null);
  const [buildResult, setBuildResult] = useState<BuildResult | null>(null);
  const [buildError, setBuildError] = useState("");

  useSceneControlSync({
    document: studioDocument,
    renderErrors: viewportStatus.renderErrors,
    synchronize: synchronizeDocument,
    reportError: setActionError,
  });

  const activeCatalog = useMemo(
    () => catalog.find((asset) => (
      asset.id === studioDocument.assetId
      && asset.version === studioDocument.assetVersion
    )) ?? null,
    [catalog, studioDocument.assetId, studioDocument.assetVersion],
  );
  const selectedEntity = useMemo(() => {
    if (!viewportStatus.selectedId?.startsWith("entity:")) return null;
    const id = viewportStatus.selectedId.slice("entity:".length);
    return studioDocument.entities.find((entity) => entity.id === id) ?? null;
  }, [studioDocument.entities, viewportStatus.selectedId]);
  const sourceReady = Boolean(activeCatalog?.browser.spz)
    || studioDocument.references.some((reference) => reference.kind !== "mesh" && Boolean(reference.objectUrl));
  const assetReady = Boolean(activeCatalog?.browser.glb);

  useEffect(() => {
    const controller = new AbortController();
    setCatalogLoading(true);
    setCatalogError("");
    loadCatalog(controller.signal).then((assets) => {
      setCatalog(assets);
      setCatalogLoading(false);
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setCatalog([]);
      setCatalogError(error instanceof Error ? error.message : "The local catalog could not be read.");
      setCatalogLoading(false);
    });
    return () => controller.abort();
  }, [catalogAttempt]);

  useEffect(() => {
    if (!activeCatalog) {
      setManifest(null);
      setManifestError("");
      return;
    }
    const controller = new AbortController();
    setManifest(null);
    setManifestError("");
    loadCollisionManifest(activeCatalog.manifest, controller.signal).then(setManifest).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setManifestError(error instanceof Error ? error.message : "The collision manifest could not be read.");
    });
    return () => controller.abort();
  }, [activeCatalog]);

  useEffect(() => {
    let cancelled = false;
    void hydrateReferenceBlobs(initialReferences.current).then(({ hydrated, failures }) => {
      if (cancelled) {
        hydrated.forEach(({ objectUrl }) => URL.revokeObjectURL(objectUrl));
        return;
      }
      hydrated.forEach(({ objectUrl }) => ownedObjectUrls.current.add(objectUrl));
      hydrateReferences(hydrated);
      if (failures.length > 0) {
        const [{ name, error }] = failures;
        const suffix = failures.length > 1 ? ` (${failures.length} references affected)` : "";
        setActionError(`Saved reference “${name}” could not be restored: ${error.message}${suffix}`);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [hydrateReferences]);

  useEffect(() => {
    appMounted.current = true;
    return () => {
      appMounted.current = false;
      buildAbortRef.current?.abort();
      ownedObjectUrls.current.forEach((url) => URL.revokeObjectURL(url));
      ownedObjectUrls.current.clear();
    };
  }, []);
  useEffect(() => {
    if (!viewportErrorPattern.test(viewportStatus.message)) {
      setDismissedViewportMessage("");
    }
  }, [viewportStatus.message]);

  const exportScene = useCallback(() => {
    try {
      downloadText(serializeStudioDocument(studioDocument), safeDownloadName(studioDocument.name));
      setActionError("");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The scene could not be downloaded.");
    }
  }, [studioDocument]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        exportScene();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
        return;
      }
      if (isEditableTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "q") setMode("select");
      else if (key === "w") setMode("translate");
      else if (key === "e") setMode("rotate");
      else if (key === "m") setMode("measure");
      else if (key === "f") viewportRef.current?.focus();
      else if (key === "1") dispatch({ type: "viewport.preset.set", preset: "front" });
      else if (key === "3") dispatch({ type: "viewport.preset.set", preset: "right" });
      else if (key === "7") dispatch({ type: "viewport.preset.set", preset: "top" });
      else if (key === "Escape") {
        setLeftOpen(false);
        setInspectorOpen(false);
        setBuildOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dispatch, exportScene, redo, undo]);

  const closeResponsivePanels = () => {
    setLeftOpen(false);
    setInspectorOpen(false);
    setBuildOpen(false);
  };

  const toggleLeft = () => {
    setLeftOpen((open) => !open);
    setInspectorOpen(false);
    setBuildOpen(false);
  };

  const toggleInspector = () => {
    setInspectorOpen((open) => !open);
    setLeftOpen(false);
    setBuildOpen(false);
  };

  const toggleBuild = () => {
    setBuildOpen((open) => !open);
    setLeftOpen(false);
    setInspectorOpen(false);
  };

  const importReference = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    let kind: ReferenceLayer["kind"];
    try {
      ({ kind } = validateReferenceImport(file));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The reference file is not supported.");
      return;
    }

    const id = crypto.randomUUID();
    try {
      // Commit durable bytes before exposing the undoable reference in scene state.
      await putReferenceBlob(id, file);
      if (!appMounted.current) return;
      const objectUrl = URL.createObjectURL(file);
      ownedObjectUrls.current.add(objectUrl);
      const reference: ReferenceLayer = {
        id,
        name: file.name,
        kind,
        objectUrl,
        transform: { position: [0, 0, 0], quaternionXyzw: [0, 0, 0, 1], scale: [1, 1, 1] },
        opacity: 1,
        visible: true,
      };
      dispatch({ type: "reference.add", reference });
      setDockTab("scene");
      setActionError("");
    } catch (error) {
      if (appMounted.current) {
        setActionError(error instanceof Error
          ? error.message
          : "The reference file could not be saved in browser storage.");
      }
    }
  };

  const removeReference = (id: string) => {
    // Keep the Blob URL alive because removing a reference is undoable.
    dispatch({ type: "reference.remove", id });
  };

  const importScene = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setActionError("Asset recipe JSON is larger than 5 MB. Keep binary data in external source files.");
      return;
    }
    try {
      const parsed = parseStudioDocumentJson(await file.text());
      if (parsed.references.some((reference) => reference.objectUrl !== undefined)) {
        throw new Error("reference objectUrl values are not allowed in scene files; remove them and re-import each local file");
      }
      replaceDocument(parsed);
      setActionError("");
      setDockTab("scene");
    } catch (error) {
      setActionError(error instanceof Error ? `Scene import failed: ${error.message}` : "Scene import failed because the file is invalid.");
    }
  };

  const resetScene = () => {
    if (!window.confirm("Reset the asset workspace? This clears local sources, objects, and measurements.")) return;
    dispatch({ type: "reset" });
    setMode("select");
    setActionError("");
  };

  const startBuild = async (target: BuildTarget) => {
    const controller = new AbortController();
    buildAbortRef.current = controller;
    setBuildTarget(target);
    setBuildResult(null);
    setBuildError("");
    try {
      setBuildResult(await requestBuild(target, controller.signal));
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setBuildError("Build request cancelled. A local exporter already running may finish in the server process.");
      } else if (error instanceof TypeError) {
        setBuildError("The local build service is unavailable. Start it with “bun run dev:server”, then retry.");
      } else {
        setBuildError(error instanceof Error ? error.message : "The local build service returned an unreadable response. Restart it, then retry.");
      }
    } finally {
      if (buildAbortRef.current === controller) buildAbortRef.current = null;
      setBuildTarget(null);
    }
  };

  const cancelBuild = () => buildAbortRef.current?.abort();
  const setView = (preset: ViewPreset) => dispatch({ type: "viewport.preset.set", preset });
  const setLayer = (layer: keyof LayerVisibility, visible: boolean) => dispatch({ type: "layer.visibility.set", layer, visible });
  const updateEntity = (entity: SceneEntity) => dispatch({ type: "entity.upsert", entity });
  const updateEntityTransform = (id: string, transform: Transform) => {
    const entity = studioDocument.entities.find((candidate) => candidate.id === id);
    if (entity) updateEntity({ ...entity, transform });
  };
  const addMeasurement = (measurement: Measurement) => dispatch({ type: "measurement.add", measurement });
  const viewportError = viewportErrorPattern.test(viewportStatus.message)
    ? viewportStatus.message
    : "";
  const visibleWorkspaceError = actionError
    || manifestError
    || (viewportError !== dismissedViewportMessage ? viewportError : "");

  return (
    <div className="studio-shell">
      <CommandBar
        projectName={studioDocument.name}
        mode={mode}
        canUndo={canUndo}
        canRedo={canRedo}
        leftOpen={leftOpen}
        inspectorOpen={inspectorOpen}
        buildOpen={buildOpen}
        onModeChange={setMode}
        onUndo={undo}
        onRedo={redo}
        onReset={resetScene}
        onImportReference={() => referenceInputRef.current?.click()}
        onImportScene={() => sceneInputRef.current?.click()}
        onExportScene={exportScene}
        onToggleLeft={toggleLeft}
        onToggleInspector={toggleInspector}
        onToggleBuild={toggleBuild}
      />

      <PipelineStrip
        sourceReady={sourceReady}
        assetReady={assetReady}
        onOpenExports={() => {
          setBuildOpen(true);
          setLeftOpen(false);
          setInspectorOpen(false);
        }}
      />

      <input ref={referenceInputRef} className="visually-hidden" type="file" accept=".ply,.splat,.ksplat,.spz,.glb,.obj" onChange={importReference} />
      <input ref={sceneInputRef} className="visually-hidden" type="file" accept="application/json,.json,.asset.json" onChange={importScene} />

      <div className="studio-main">
        <WorkspaceDock
          open={leftOpen}
          tab={dockTab}
          catalog={catalog}
          activeAssetId={studioDocument.assetId}
          activeAssetVersion={studioDocument.assetVersion}
          catalogLoading={catalogLoading}
          catalogError={catalogError}
          layers={studioDocument.layers}
          references={studioDocument.references}
          measurements={studioDocument.measurements}
          onTabChange={setDockTab}
          onSelectAsset={(assetId, assetVersion) => dispatch({ type: "asset.select", assetId, assetVersion })}
          onRetryCatalog={() => setCatalogAttempt((attempt) => attempt + 1)}
          onAddReference={() => referenceInputRef.current?.click()}
          onLayerChange={setLayer}
          onRemoveReference={removeReference}
          onRemoveMeasurement={(id) => dispatch({ type: "measurement.remove", id })}
          onClose={() => setLeftOpen(false)}
        />

        <main className="viewport-region">
          <ViewportToolbar
            mode={mode}
            splatVisible={studioDocument.layers.catalogVisuals}
            assetVisible={studioDocument.layers.assetVisuals}
            collisionsVisible={studioDocument.layers.collisions}
            onModeChange={setMode}
            onView={setView}
            onFocus={() => viewportRef.current?.focus()}
            onToggleSplat={() => setLayer("catalogVisuals", !studioDocument.layers.catalogVisuals)}
            onToggleAsset={() => setLayer("assetVisuals", !studioDocument.layers.assetVisuals)}
            onToggleCollisions={() => setLayer("collisions", !studioDocument.layers.collisions)}
          />
          <div className="viewport-stage">
            <ThreeViewport
              ref={viewportRef}
              document={studioDocument}
              catalog={activeCatalog}
              catalogPending={catalogLoading}
              manifest={manifest}
              mode={mode}
              onEntityTransformChange={updateEntityTransform}
              onMeasurement={addMeasurement}
              onStatus={setViewportStatus}
            />
            {studioDocument.layers.measurements && <OverlayLegend bounds={studioDocument.bounds} onDismiss={() => dispatch({ type: "bounds.set", bounds: [] })} />}
            {!activeCatalog && !catalogLoading && <div className="viewport-empty"><span aria-hidden="true">⌖</span><strong>Asset package unavailable</strong><p>The recipe requests {studioDocument.assetId} version {studioDocument.assetVersion}. Add that package to catalog.json or import a local source.</p></div>}
            {visibleWorkspaceError && <div className="viewport-alert" role="alert"><div><strong>Workspace needs attention</strong><p>{visibleWorkspaceError}</p></div><button type="button" onClick={() => {
              if (actionError) setActionError("");
              else if (manifestError) setManifestError("");
              else setDismissedViewportMessage(viewportError);
            }} aria-label="Dismiss workspace error">×</button></div>}
          </div>
          <DatumStrip status={viewportStatus} measurementMode={mode === "measure"} />
        </main>

        <InspectorPanel
          open={inspectorOpen}
          catalog={activeCatalog}
          selectedEntity={selectedEntity}
          layers={studioDocument.layers}
          onEntityChange={updateEntity}
          onLayerChange={setLayer}
          onClose={() => setInspectorOpen(false)}
        />
      </div>

      <BuildPanel open={buildOpen} activeTarget={buildTarget} result={buildResult} error={buildError} onBuild={startBuild} onCancel={cancelBuild} onClose={() => setBuildOpen(false)} />
      {(leftOpen || inspectorOpen || buildOpen) && <button type="button" className="drawer-backdrop" onClick={closeResponsivePanels} aria-label="Close open panel" />}
      <StatusBar catalogCount={catalog.length} collisionCount={studioDocument.collisions.length || manifest?.collision_boxes.length || 0} referenceCount={studioDocument.references.length} status={viewportStatus} />
      <div className="visually-hidden" aria-live="polite">{viewportStatus.message}</div>
    </div>
  );
}
