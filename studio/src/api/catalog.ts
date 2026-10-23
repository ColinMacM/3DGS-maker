import type { CatalogEntry, CollisionBox, Transform, Vec3 } from "../domain/types";

interface CatalogIndex {
  schemaVersion: 1;
  assets: CatalogEntry[];
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${context} must be a non-empty string.`);
  }
  return value;
}

function vec3(value: unknown, context: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3 || value.some((part) => typeof part !== "number" || !Number.isFinite(part))) {
    throw new Error(`${context} must contain three finite numbers.`);
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

function transform(value: unknown, context: string): Transform {
  const item = record(value, context);
  const quaternion = item.quaternionXyzw;
  if (
    !Array.isArray(quaternion)
    || quaternion.length !== 4
    || quaternion.some((part) => typeof part !== "number" || !Number.isFinite(part))
    || quaternion.every((part) => part === 0)
  ) {
    throw new Error(`${context}.quaternionXyzw must contain four finite values and must not be zero.`);
  }
  const scale = vec3(item.scale, `${context}.scale`);
  if (scale.some((part) => part <= 0)) {
    throw new Error(`${context}.scale values must be greater than zero.`);
  }
  return {
    position: vec3(item.position, `${context}.position`),
    quaternionXyzw: [quaternion[0], quaternion[1], quaternion[2], quaternion[3]],
    scale,
  };
}

function catalogEntry(value: unknown, index: number): CatalogEntry {
  const item = record(value, `Catalog asset ${index + 1}`);
  if (item.schemaVersion !== 1 || item.units !== "m" || item.upAxis !== "Z") {
    throw new Error(`Catalog asset ${index + 1} must use schema version 1, metres, and Z-up.`);
  }
  const browser = record(item.browser, `Catalog asset ${index + 1} browser`);
  const spz = browser.spz === undefined
    ? undefined
    : record(browser.spz, `Catalog asset ${index + 1} browser SPZ`);
  const simulator = record(item.simulator, `Catalog asset ${index + 1} simulator`);
  if (!Array.isArray(item.capabilities) || item.capabilities.some((value) => typeof value !== "string")) {
    throw new Error(`Catalog asset ${index + 1} capabilities must be strings.`);
  }
  return {
    schemaVersion: 1,
    id: text(item.id, `Catalog asset ${index + 1} id`),
    version: text(item.version, `Catalog asset ${index + 1} version`),
    name: text(item.name, `Catalog asset ${index + 1} name`),
    description: text(item.description, `Catalog asset ${index + 1} description`),
    ...(typeof item.thumbnail === "string" ? { thumbnail: item.thumbnail } : {}),
    units: "m",
    upAxis: "Z",
    browser: {
      glb: text(browser.glb, `Catalog asset ${index + 1} browser GLB`),
      ...(spz ? {
        spz: {
          url: text(spz.url, `Catalog asset ${index + 1} browser SPZ URL`),
          transform: transform(spz.transform, `Catalog asset ${index + 1} browser SPZ transform`),
        },
      } : {}),
    },
    manifest: text(item.manifest, `Catalog asset ${index + 1} manifest`),
    simulator: {
      isaac: text(simulator.isaac, `Catalog asset ${index + 1} Isaac Sim output`),
      mujoco: text(simulator.mujoco, `Catalog asset ${index + 1} MuJoCo output`),
      unreal: text(simulator.unreal, `Catalog asset ${index + 1} Unreal output`),
    },
    capabilities: [...item.capabilities] as string[],
  };
}

async function fetchJson(url: string, label: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { signal, headers: { Accept: "application/json" } });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error(`${label} could not be read. Start the local studio server and retry.`);
  }
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}. Check the local asset package.`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

export function parseCatalog(value: unknown): CatalogEntry[] {
  const catalog = record(value, "The asset catalog");
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.assets)) {
    throw new Error("The asset catalog must use schema version 1 and contain an assets array.");
  }
  return (catalog as unknown as CatalogIndex).assets.map(catalogEntry);
}

export async function loadCatalog(signal?: AbortSignal): Promise<CatalogEntry[]> {
  return parseCatalog(await fetchJson("/catalog.json", "The asset catalog", signal));
}

export async function loadCollisionManifest(url: string, signal?: AbortSignal): Promise<{ collision_boxes: CollisionBox[] }> {
  const value = record(await fetchJson(url, "The collision manifest", signal), "The collision manifest");
  if (!Array.isArray(value.collision_boxes)) {
    throw new Error("The collision manifest does not contain a collision_boxes array.");
  }
  const collision_boxes = value.collision_boxes.map((rawBox, index) => {
    const box = record(rawBox, `Collision box ${index + 1}`);
    const rawQuaternion = box.quatWxyz ?? box.quat;
    if (!Array.isArray(rawQuaternion) || rawQuaternion.length !== 4 || rawQuaternion.some((part) => typeof part !== "number" || !Number.isFinite(part))) {
      throw new Error(`Collision box ${index + 1} quaternion must contain four finite WXYZ values.`);
    }
    return {
      name: text(box.name, `Collision box ${index + 1} name`),
      pos: vec3(box.pos, `Collision box ${index + 1} position`),
      quatWxyz: [rawQuaternion[0], rawQuaternion[1], rawQuaternion[2], rawQuaternion[3]],
      size: vec3(box.size, `Collision box ${index + 1} size`),
    } satisfies CollisionBox;
  });
  return { collision_boxes };
}
