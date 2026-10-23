import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { parseCatalog } from "../api/catalog";
import type { CatalogEntry } from "../domain/types";

const REPOSITORY_ROOT = resolve(decodeURIComponent(new URL("../../../", import.meta.url).pathname));
/** Repo `assets/`: the URL root for catalog files and model `source` paths. */
export const ASSETS_ROOT = resolve(REPOSITORY_ROOT, "assets");

/** Resolves a same-origin asset URL path (e.g. `/fr10/browser/fr10_home.glb`) inside repo `assets/`. */
export function assetFilePath(url: string): string {
  const relative = url.split(/[?#]/, 1)[0].replace(/^\/+/, "");
  if (!relative || relative.includes("\\") || relative.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Asset URL must be a safe path rooted at repo assets/: ${url}`);
  }
  const path = resolve(ASSETS_ROOT, relative);
  if (!path.startsWith(`${ASSETS_ROOT}${sep}`)) {
    throw new Error(`Asset URL escapes repo assets/: ${url}`);
  }
  return path;
}

/** Rejects model sources the browser would fetch as HTTP 404. */
export async function assertModelSourceExists(source: string): Promise<void> {
  const path = assetFilePath(source);
  const hint = source.startsWith("/assets/")
    ? ` Model URLs are rooted at repo assets/, so drop the leading "/assets" (try "${source.slice("/assets".length)}").`
    : " Model URLs are rooted at repo assets/, e.g. /fr10/browser/fr10_home.glb.";
  try {
    if ((await stat(path)).isFile()) return;
  } catch {
    // Reported below with the URL-root hint.
  }
  throw new Error(`Model source file does not exist: ${source} (looked for ${path}).${hint}`);
}

export async function readCatalog(): Promise<CatalogEntry[]> {
  return parseCatalog(JSON.parse(await readFile(resolve(ASSETS_ROOT, "catalog.json"), "utf8")));
}
