import type { ReferenceKind } from "../domain/types";

const MEBIBYTE = 1024 * 1024;

export const MAX_MESH_REFERENCE_BYTES = 512 * MEBIBYTE;
export const MAX_SPLAT_REFERENCE_BYTES = 1024 * MEBIBYTE;

const REFERENCE_EXTENSIONS: Readonly<Record<string, ReferenceKind>> = {
  ply: "splat",
  splat: "splat",
  ksplat: "splat",
  spz: "splat",
  glb: "mesh",
  obj: "mesh",
};

export interface ReferenceImportDetails {
  kind: ReferenceKind;
  maximumBytes: number;
}

export class ReferenceImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferenceImportError";
  }
}

export function validateReferenceImport(file: Pick<File, "name" | "size">): ReferenceImportDetails {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const kind = REFERENCE_EXTENSIONS[extension];
  if (!kind) {
    throw new ReferenceImportError(
      "Unsupported reference file. Choose PLY, SPLAT, KSPLAT, SPZ, GLB, or OBJ.",
    );
  }

  const maximumBytes = kind === "mesh" ? MAX_MESH_REFERENCE_BYTES : MAX_SPLAT_REFERENCE_BYTES;
  if (file.size > maximumBytes) {
    const limit = kind === "mesh" ? "512 MiB" : "1 GiB";
    throw new ReferenceImportError(
      `${kind === "mesh" ? "Mesh" : "Splat or point-cloud"} references are limited to ${limit}. Choose a smaller file.`,
    );
  }

  return { kind, maximumBytes };
}
