import type { ReferenceLayer } from "../domain/types";

const DATABASE_NAME = "workcell-studio";
const DATABASE_VERSION = 1;
const REFERENCE_BLOB_STORE = "referenceBlobs";

export class ReferenceBlobPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReferenceBlobPersistenceError";
  }
}

function defaultIndexedDb(): IDBFactory {
  try {
    if (typeof indexedDB === "undefined") {
      throw new Error("IndexedDB is not available in this browser");
    }
    return indexedDB;
  } catch (error) {
    throw new ReferenceBlobPersistenceError(
      "Local reference storage is unavailable in this browser.",
      { cause: error },
    );
  }
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    try {
      request = factory.open(DATABASE_NAME, DATABASE_VERSION);
    } catch (error) {
      fail(error);
      return;
    }

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(REFERENCE_BLOB_STORE)) {
        database.createObjectStore(REFERENCE_BLOB_STORE);
      }
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      resolve(request.result);
    };
    request.onerror = () => fail(request.error ?? new Error("IndexedDB could not be opened"));
    request.onblocked = () => fail(new Error("IndexedDB upgrade was blocked by another tab"));
  });
}

export async function putReferenceBlob(
  referenceId: string,
  blob: Blob,
  factory: IDBFactory = defaultIndexedDb(),
): Promise<void> {
  let database: IDBDatabase | undefined;
  try {
    database = await openDatabase(factory);
    await new Promise<void>((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = database!.transaction(REFERENCE_BLOB_STORE, "readwrite");
        transaction.objectStore(REFERENCE_BLOB_STORE).put(blob, referenceId);
      } catch (error) {
        reject(error);
        return;
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB write failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB write was aborted"));
    });
  } catch (error) {
    if (error instanceof ReferenceBlobPersistenceError) throw error;
    throw new ReferenceBlobPersistenceError(
      "The reference file could not be saved in browser storage. Free browser storage and try again.",
      { cause: error },
    );
  } finally {
    database?.close();
  }
}

export async function getReferenceBlob(
  referenceId: string,
  factory: IDBFactory = defaultIndexedDb(),
): Promise<Blob | undefined> {
  let database: IDBDatabase | undefined;
  try {
    database = await openDatabase(factory);
    return await new Promise<Blob | undefined>((resolve, reject) => {
      let transaction: IDBTransaction;
      let request: IDBRequest<Blob | undefined>;
      try {
        transaction = database!.transaction(REFERENCE_BLOB_STORE, "readonly");
        request = transaction.objectStore(REFERENCE_BLOB_STORE).get(referenceId);
      } catch (error) {
        reject(error);
        return;
      }
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB read was aborted"));
    });
  } catch (error) {
    if (error instanceof ReferenceBlobPersistenceError) throw error;
    throw new ReferenceBlobPersistenceError(
      "Saved reference files could not be read from browser storage.",
      { cause: error },
    );
  } finally {
    database?.close();
  }
}

export interface HydratedReferenceBlob {
  id: string;
  objectUrl: string;
}

export interface ReferenceBlobHydrationFailure {
  id: string;
  name: string;
  error: Error;
}

export interface ReferenceBlobHydrationResult {
  hydrated: HydratedReferenceBlob[];
  failures: ReferenceBlobHydrationFailure[];
}

/**
 * Restores only runtime object URLs. Reference metadata remains owned by the
 * document and missing bytes leave that reference explicitly unavailable.
 */
export async function hydrateReferenceBlobs(
  references: readonly ReferenceLayer[],
  loadBlob: (referenceId: string) => Promise<Blob | undefined> = getReferenceBlob,
  createObjectUrl: (blob: Blob) => string = (blob) => URL.createObjectURL(blob),
): Promise<ReferenceBlobHydrationResult> {
  const hydrated: HydratedReferenceBlob[] = [];
  const failures: ReferenceBlobHydrationFailure[] = [];

  for (const reference of references) {
    if (reference.objectUrl) continue;
    try {
      const blob = await loadBlob(reference.id);
      if (!blob) continue;
      hydrated.push({ id: reference.id, objectUrl: createObjectUrl(blob) });
    } catch (error) {
      failures.push({
        id: reference.id,
        name: reference.name,
        error: error instanceof Error ? error : new Error("Unknown browser storage error"),
      });
    }
  }

  return { hydrated, failures };
}
