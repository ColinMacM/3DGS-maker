import { useEffect, useRef, useState } from "react";
import type { StudioDocument } from "../domain/types";
import {
  fetchControlledScene,
  replaceControlledScene,
  reportControlledViewerStatus,
  SceneControlApiError,
} from "./scene-control";
import {
  MAX_VIEWER_RENDER_ERROR_LENGTH,
  MAX_VIEWER_RENDER_ERRORS,
  mergeRuntimeReferenceUrls,
  SCENE_POLL_INTERVAL_MS,
  sceneDocumentSignature,
  type SceneSnapshot,
} from "./scene-control-contract";

const LOCAL_PUSH_DELAY_MS = 120;

export interface SceneControlSyncOptions {
  document: StudioDocument;
  /** Current viewport load/render failures, reported to the server with every poll. */
  renderErrors: readonly string[];
  synchronize(document: StudioDocument): void;
  reportError(message: string): void;
}

export function controlledSnapshotChanged(
  snapshot: SceneSnapshot,
  currentRevision: number | null,
  remoteSignature: string,
): boolean {
  return snapshot.revision !== currentRevision
    || sceneDocumentSignature(snapshot.document) !== remoteSignature;
}

export function useSceneControlSync({
  document,
  renderErrors,
  synchronize,
  reportError,
}: SceneControlSyncOptions): void {
  const documentRef = useRef(document);
  const revisionRef = useRef<number | null>(null);
  const remoteSignatureRef = useRef("");
  const revisionMarkerRef = useRef("");
  const mutationChainRef = useRef<Promise<void>>(Promise.resolve());
  const syncErrorReportedRef = useRef(false);
  const renderErrorsRef = useRef<readonly string[]>([]);
  const wakePollRef = useRef<(() => void) | null>(null);
  const [ready, setReady] = useState(false);

  documentRef.current = document;
  const reportedRenderErrors = renderErrors
    .slice(0, MAX_VIEWER_RENDER_ERRORS)
    .map((message) => message.slice(0, MAX_VIEWER_RENDER_ERROR_LENGTH));
  const renderErrorsKey = JSON.stringify(reportedRenderErrors);
  renderErrorsRef.current = reportedRenderErrors;

  const applySnapshot = (snapshot: SceneSnapshot): void => {
    revisionRef.current = snapshot.revision;
    remoteSignatureRef.current = sceneDocumentSignature(snapshot.document);
    synchronize(mergeRuntimeReferenceUrls(snapshot.document, documentRef.current));
  };

  useEffect(() => {
    const controller = new AbortController();
    let retryTimer: number | undefined;
    const connect = async () => {
      try {
        let snapshot = await fetchControlledScene(controller.signal);
        if (!snapshot.persisted) {
          snapshot = await replaceControlledScene(
            snapshot.revision,
            documentRef.current,
            controller.signal,
          );
        }
        if (controller.signal.aborted) return;
        applySnapshot(snapshot);
        if (syncErrorReportedRef.current) {
          syncErrorReportedRef.current = false;
          reportError("");
        }
        setReady(true);
      } catch (error) {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
        syncErrorReportedRef.current = true;
        reportError(
          error instanceof Error
            ? `Scene-control API unavailable: ${error.message}`
            : "Scene-control API unavailable.",
        );
        retryTimer = window.setTimeout(() => void connect(), SCENE_POLL_INTERVAL_MS);
      }
    };
    void connect();
    return () => {
      controller.abort();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [reportError, synchronize]);

  useEffect(() => {
    if (!ready) return undefined;
    const controller = new AbortController();
    let pollTimer: number | undefined;
    let inFlight = false;
    let pollAgain = false;
    const poll = async () => {
      if (inFlight) {
        pollAgain = true;
        return;
      }
      inFlight = true;
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
      try {
        const marker = await reportControlledViewerStatus(renderErrorsRef.current, controller.signal);
        const markerKey = `${marker.instanceId}:${marker.revision}`;
        if (!controller.signal.aborted && markerKey !== revisionMarkerRef.current) {
          const snapshot = await fetchControlledScene(controller.signal);
          revisionMarkerRef.current = markerKey;
          if (
            controlledSnapshotChanged(
              snapshot,
              revisionRef.current,
              remoteSignatureRef.current,
            )
          ) {
            applySnapshot(snapshot);
          }
        }
        if (syncErrorReportedRef.current) {
          syncErrorReportedRef.current = false;
          reportError("");
        }
      } catch (error) {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
        syncErrorReportedRef.current = true;
        reportError(
          error instanceof Error
            ? `Scene-control synchronization failed: ${error.message}`
            : "Scene-control synchronization failed.",
        );
      } finally {
        inFlight = false;
      }
      if (!controller.signal.aborted) {
        const delay = pollAgain ? 0 : SCENE_POLL_INTERVAL_MS;
        pollAgain = false;
        pollTimer = window.setTimeout(() => void poll(), delay);
      }
    };
    wakePollRef.current = () => void poll();
    void poll();
    return () => {
      wakePollRef.current = null;
      controller.abort();
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
    };
  }, [ready, reportError, synchronize]);

  useEffect(() => {
    wakePollRef.current?.();
  }, [renderErrorsKey]);

  useEffect(() => {
    if (!ready) return undefined;
    const signature = sceneDocumentSignature(document);
    if (signature === remoteSignatureRef.current) return undefined;
    const expectedRevision = revisionRef.current;
    if (expectedRevision === null) return undefined;
    const localDocument = document;
    const localSignature = signature;
    const timer = window.setTimeout(() => {
      const mutation = async () => {
        if (localSignature === remoteSignatureRef.current) return;
        try {
          const snapshot = await replaceControlledScene(expectedRevision, localDocument);
          revisionRef.current = snapshot.revision;
          remoteSignatureRef.current = sceneDocumentSignature(snapshot.document);
        } catch (error) {
          if (error instanceof SceneControlApiError && error.status === 409) {
            try {
              applySnapshot(await fetchControlledScene());
              return;
            } catch (refreshError) {
              reportError(refreshError instanceof Error ? refreshError.message : "Scene conflict recovery failed.");
              return;
            }
          }
          reportError(
            error instanceof Error
              ? `Scene-control save failed: ${error.message}`
              : "Scene-control save failed.",
          );
        }
      };
      const result = mutationChainRef.current.then(mutation, mutation);
      mutationChainRef.current = result.then(() => undefined, () => undefined);
    }, LOCAL_PUSH_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [document, ready, reportError, synchronize]);
}
