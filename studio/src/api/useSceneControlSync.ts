import { useEffect, useRef, useState } from "react";
import type { StudioDocument } from "../domain/types";
import {
  fetchControlledScene,
  replaceControlledScene,
  SceneControlApiError,
} from "./scene-control";
import {
  mergeRuntimeReferenceUrls,
  sceneDocumentSignature,
  type SceneSnapshot,
} from "./scene-control-contract";

const POLL_INTERVAL_MS = 500;
const LOCAL_PUSH_DELAY_MS = 120;

export interface SceneControlSyncOptions {
  document: StudioDocument;
  synchronize(document: StudioDocument): void;
  reportError(message: string): void;
}


export function useSceneControlSync({
  document,
  synchronize,
  reportError,
}: SceneControlSyncOptions): void {
  const documentRef = useRef(document);
  const revisionRef = useRef<number | null>(null);
  const remoteSignatureRef = useRef("");
  const mutationChainRef = useRef<Promise<void>>(Promise.resolve());
  const [ready, setReady] = useState(false);

  documentRef.current = document;

  const applySnapshot = (snapshot: SceneSnapshot): void => {
    revisionRef.current = snapshot.revision;
    remoteSignatureRef.current = sceneDocumentSignature(snapshot.document);
    synchronize(mergeRuntimeReferenceUrls(snapshot.document, documentRef.current));
  };

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
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
        setReady(true);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        reportError(
          error instanceof Error
            ? `Scene-control API unavailable: ${error.message}`
            : "Scene-control API unavailable.",
        );
      }
    })();
    return () => controller.abort();
  }, [reportError, synchronize]);

  useEffect(() => {
    if (!ready) return undefined;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const snapshot = await fetchControlledScene(controller.signal);
        if (
          !controller.signal.aborted
          && snapshot.revision !== revisionRef.current
        ) {
          applySnapshot(snapshot);
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          reportError(
            error instanceof Error
              ? `Scene-control synchronization failed: ${error.message}`
              : "Scene-control synchronization failed.",
          );
        }
      }
    };
    const interval = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [ready, reportError, synchronize]);

  useEffect(() => {
    if (!ready) return undefined;
    const signature = sceneDocumentSignature(document);
    if (signature === remoteSignatureRef.current) return undefined;

    const timer = window.setTimeout(() => {
      const localDocument = document;
      const localSignature = signature;
      const mutation = async () => {
        if (localSignature === remoteSignatureRef.current) return;
        const expectedRevision = revisionRef.current;
        if (expectedRevision === null) return;
        try {
          const snapshot = await replaceControlledScene(expectedRevision, localDocument);
          revisionRef.current = snapshot.revision;
          remoteSignatureRef.current = sceneDocumentSignature(snapshot.document);
        } catch (error) {
          if (error instanceof SceneControlApiError && error.status === 409) {
            try {
              applySnapshot(await fetchControlledScene());
              reportError("The scene changed through the control API; the browser loaded the newer revision.");
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
