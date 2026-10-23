import {
  getReferenceAvailability,
  isBlobObjectUrl,
  markReferenceUnavailable,
} from "../domain/referenceAvailability";
import { serializeStudioDocument, validateStudioDocument } from "../domain/schema";
import type { StudioDocument } from "../domain/types";

export const STUDIO_DRAFT_STORAGE_KEY = "asset-studio:draft:v1";
const BROWSER_REFERENCE_UNAVAILABLE_REASON =
  "The local file could not be restored from browser storage. Re-import it to restore this reference.";

interface StoredDraftV1 {
  storageVersion: 1;
  savedAt: string;
  document: unknown;
  unavailableReferences: Array<{ id: string; reason: string; visible?: boolean }>;
}

export class DraftPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DraftPersistenceError";
  }
}

function defaultStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function saveStudioDraft(
  document: StudioDocument,
  storage: Storage | null = defaultStorage(),
): void {
  if (!storage) return;
  const unavailableReferences = document.references
    .filter(({ objectUrl }) => !objectUrl || isBlobObjectUrl(objectUrl))
    .map((reference) => ({
      id: reference.id,
      reason: getReferenceAvailability(reference).reason ?? BROWSER_REFERENCE_UNAVAILABLE_REASON,
      visible: reference.visible,
    }));
  const durableDocument = JSON.parse(serializeStudioDocument(document)) as unknown;
  const stored: StoredDraftV1 = {
    storageVersion: 1,
    savedAt: new Date().toISOString(),
    document: durableDocument,
    unavailableReferences,
  };
  try {
    storage.setItem(STUDIO_DRAFT_STORAGE_KEY, JSON.stringify(stored));
  } catch (error) {
    throw new DraftPersistenceError("Unable to save the studio draft to local storage", { cause: error });
  }
}

export function loadStudioDraft(storage: Storage | null = defaultStorage()): StudioDocument | null {
  if (!storage) return null;
  let text: string | null;
  try {
    text = storage.getItem(STUDIO_DRAFT_STORAGE_KEY);
  } catch (error) {
    throw new DraftPersistenceError("Unable to read the studio draft from local storage", { cause: error });
  }
  if (text === null) return null;

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new DraftPersistenceError("Stored studio draft is not valid JSON", { cause: error });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DraftPersistenceError("Stored studio draft must be an object");
  }

  const stored = value as Partial<StoredDraftV1>;
  if (stored.storageVersion !== 1) {
    throw new DraftPersistenceError(`Unsupported stored draft version: ${String(stored.storageVersion)}`);
  }
  if (!Array.isArray(stored.unavailableReferences)) {
    throw new DraftPersistenceError("Stored studio draft is missing unavailableReferences metadata");
  }

  const unavailableMetadata = new Map<string, { reason: string; visible?: boolean }>();
  stored.unavailableReferences.forEach((item, index) => {
    if (
      typeof item !== "object"
      || item === null
      || typeof item.id !== "string"
      || typeof item.reason !== "string"
      || (item.visible !== undefined && typeof item.visible !== "boolean")
    ) {
      throw new DraftPersistenceError(`Stored unavailableReferences[${index}] is invalid`);
    }
    unavailableMetadata.set(item.id, { reason: item.reason, visible: item.visible });
  });

  const document = validateStudioDocument(stored.document);
  return {
    ...document,
    references: document.references.map((reference) => {
      const metadata = unavailableMetadata.get(reference.id);
      if (metadata || !reference.objectUrl || isBlobObjectUrl(reference.objectUrl)) {
        const unavailable = markReferenceUnavailable(
          reference,
          metadata?.reason ?? BROWSER_REFERENCE_UNAVAILABLE_REASON,
        );
        unavailable.visible = metadata?.visible ?? reference.visible;
        return unavailable;
      }
      return reference;
    }),
  };
}

export function removeStudioDraft(storage: Storage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(STUDIO_DRAFT_STORAGE_KEY);
  } catch (error) {
    throw new DraftPersistenceError("Unable to remove the studio draft from local storage", { cause: error });
  }
}
