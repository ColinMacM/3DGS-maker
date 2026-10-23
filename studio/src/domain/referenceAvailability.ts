import type { ReferenceLayer } from "./types";

export interface ReferenceAvailability {
  state: "available" | "unavailable";
  reason?: string;
}

const availability = Symbol("referenceAvailability");
type ReferenceWithAvailability = ReferenceLayer & {
  [availability]?: ReferenceAvailability;
};

export const LOCAL_REFERENCE_UNAVAILABLE_REASON =
  "The local file is not stored in the browser draft. Re-import it to restore this reference.";

/**
 * Attaches non-serializable runtime state to a reference whose local Blob URL cannot
 * survive a reload. The returned object remains assignable to ReferenceLayer.
 */
export function markReferenceUnavailable(
  reference: ReferenceLayer,
  reason = LOCAL_REFERENCE_UNAVAILABLE_REASON,
): ReferenceLayer {
  const copy: ReferenceWithAvailability = {
    ...reference,
    visible: false,
  };
  delete copy.objectUrl;
  Object.defineProperty(copy, availability, {
    value: { state: "unavailable", reason } satisfies ReferenceAvailability,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return copy;
}

export function getReferenceAvailability(reference: ReferenceLayer): ReferenceAvailability {
  const explicit = (reference as ReferenceWithAvailability)[availability];
  if (explicit) return explicit;
  if (!reference.objectUrl) {
    return { state: "unavailable", reason: LOCAL_REFERENCE_UNAVAILABLE_REASON };
  }
  return { state: "available" };
}

export function isBlobObjectUrl(value: string | undefined): boolean {
  return typeof value === "string" && value.startsWith("blob:");
}
