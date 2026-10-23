import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { StudioDocumentValidationError } from "./src/domain/schema";
import {
  parsePersistedSceneState,
  SceneConflictError,
  SceneRequestError,
  SceneStore,
  serializePersistedSceneState,
  type PersistedSceneState,
} from "./src/server/sceneStore";
import type { BuildResult, BuildTarget, CatalogEntry, StudioDocument } from "./src/domain/types";
import { isBuildTarget } from "./src/api/build-contract";
import { parseCatalog } from "./src/api/catalog";
import type { ScenePythonResult, SceneRevisionMarker } from "./src/api/scene-control-contract";

interface BunFile extends Blob {
  exists(): Promise<boolean>;
}

interface BunWritable {
  write(data: string | Uint8Array): number;
  end(): void;
}
interface BunSubprocess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly stdin: BunWritable;
  readonly exited: Promise<number>;
  kill(signal?: number | string): void;
}

interface BunRuntime {
  readonly env: Record<string, string | undefined>;
  file(path: string): BunFile;
  which(command: string): string | null;
  spawn(
    command: string[],
    options: {
      cwd: string;
      env: Record<string, string>;
      stdin: "ignore" | "pipe";
      stdout: "pipe";
      stderr: "pipe";
    },
  ): BunSubprocess;
  serve(options: {
    hostname: string;
    port: number;
    fetch(request: Request): Response | Promise<Response>;
    error(error: Error): Response;
  }): { hostname: string; port: number };
}

const runtimeGlobal = globalThis as typeof globalThis & { Bun: BunRuntime };
const bun = runtimeGlobal.Bun;

const HOST = "127.0.0.1";
const PORT = 4174;
const SCENE_SERVER_INSTANCE_ID = crypto.randomUUID();
const MAX_BUILD_REQUEST_BYTES = 4 * 1024;
const MAX_SCENE_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_PYTHON_REQUEST_BYTES = 128 * 1024;
const MAX_VIEWER_STATUS_REQUEST_BYTES = 128 * 1024;
const MAX_BUILD_OUTPUT_BYTES = 512 * 1024;
const MAX_PYTHON_OUTPUT_BYTES = 256 * 1024;
const MAX_PYTHON_SCRIPT_BYTES = 64 * 1024;
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
const PYTHON_TIMEOUT_MS = 10 * 1000;
const APPROVED_HOSTS: Record<string, true> = {
  "127.0.0.1:4173": true,
  "127.0.0.1:4174": true,
  "localhost:4173": true,
  "localhost:4174": true,
};
const APPROVED_ORIGINS: Record<string, true> = {
  "http://127.0.0.1:4173": true,
  "http://127.0.0.1:4174": true,
  "http://localhost:4173": true,
  "http://localhost:4174": true,
};
const KNOWN_BLENDER_PATH = "/home/colin/Downloads/blender-5.2.2-linux-x64/blender";
const STUDIO_DIRECTORY = decodeURIComponent(new URL(".", import.meta.url).pathname).replace(/\/$/, "");
const REPOSITORY_ROOT = decodeURIComponent(new URL("../", import.meta.url).pathname).replace(/\/$/, "");
const DIST_DIRECTORY = `${STUDIO_DIRECTORY}/dist`;
/** Repo `assets/`: served after `dist/`, so model `source` URLs like `/fr10/browser/fr10_home.glb` resolve. */
const ASSETS_DIRECTORY = `${REPOSITORY_ROOT}/assets`;
const CATALOG_PATH = `${ASSETS_DIRECTORY}/catalog.json`;
const SCENE_STATE_PATH = `${REPOSITORY_ROOT}/.asset-studio/scene.json`;
const PYTHON_RUNNER_PATH = `${STUDIO_DIRECTORY}/python_scene_runner.py`;

/** Package the exporters run against: the scene's `assetId`, resolved through `assets/catalog.json`. */
interface BuildPackage {
  readonly assetId: string;
  /** Repo-relative, e.g. `assets/reception_room`. */
  readonly packageDirectory: string;
  readonly artifacts: Readonly<Record<BuildTarget, string>>;
}

interface BuildDefinition {
  readonly target: BuildTarget;
  readonly package: BuildPackage;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly displayExecutable: string;
  readonly artifact: string;
}

class BuildScopeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BuildScopeError";
  }
}

interface CapturedProcess {
  readonly exitCode: number;
  readonly output: string;
  readonly oversized: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

let buildInProgress = false;
let pythonInProgress = false;

async function loadSceneState(): Promise<PersistedSceneState | undefined> {
  let text: string;
  try {
    text = await readFile(SCENE_STATE_PATH, "utf8");
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw new Error(`Unable to load ${SCENE_STATE_PATH}`, { cause: error });
  }
  try {
    return parsePersistedSceneState(JSON.parse(text));
  } catch (error) {
    throw new Error(`Unable to load ${SCENE_STATE_PATH}`, { cause: error });
  }
}

async function persistSceneState(state: PersistedSceneState): Promise<void> {
  await mkdir(dirname(SCENE_STATE_PATH), { recursive: true });
  const temporaryPath = `${SCENE_STATE_PATH}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, serializePersistedSceneState(state), "utf8");
    await rename(temporaryPath, SCENE_STATE_PATH);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}

const sceneStore = new SceneStore({
  state: await loadSceneState(),
  persist: persistSceneState,
});

function jsonHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  return headers;
}

function jsonResponse(value: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: jsonHeaders(extraHeaders),
  });
}

function apiError(status: number, error: string, extraHeaders?: HeadersInit): Response {
  return jsonResponse({ error }, status, extraHeaders);
}

function quoteArgument(argument: string): string {
  return /^[A-Za-z0-9_./:=+-]+$/.test(argument) ? argument : JSON.stringify(argument);
}

function commandFor(definition: BuildDefinition): string {
  return [definition.displayExecutable, ...definition.arguments].map(quoteArgument).join(" ");
}

function catalogRepoPath(url: string, label: string): string {
  const relative = url.startsWith("/") ? safeStaticPath(url) : null;
  if (relative === null || relative.length === 0) {
    throw new BuildScopeError(`assets/catalog.json ${label} must be a safe root-relative path, got ${JSON.stringify(url)}.`);
  }
  return `assets/${relative}`;
}

/**
 * Picks the package the exporters run against. `ASSET_PACKAGE_DIR` (plus optional
 * `ASSET_BASENAME`) overrides the selection; otherwise the scene's
 * `assetId`/`assetVersion` must match an `assets/catalog.json` entry.
 */
async function resolveBuildPackage(document: Readonly<StudioDocument>): Promise<BuildPackage> {
  const overrideDirectory = bun.env.ASSET_PACKAGE_DIR?.trim().replace(/\/+$/, "");
  if (overrideDirectory) {
    const basename = bun.env.ASSET_BASENAME?.trim()
      || overrideDirectory.slice(overrideDirectory.lastIndexOf("/") + 1);
    return {
      assetId: document.assetId,
      packageDirectory: overrideDirectory,
      artifacts: {
        isaac: `${overrideDirectory}/isaac/${basename}.usdc`,
        mujoco: `${overrideDirectory}/mujoco/${basename}.xml`,
        unreal: `${overrideDirectory}/browser/${basename}.glb`,
      },
    };
  }

  let catalog: CatalogEntry[];
  try {
    catalog = parseCatalog(JSON.parse(await readFile(CATALOG_PATH, "utf8")));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new BuildScopeError(`assets/catalog.json could not be read: ${detail}`, { cause: error });
  }
  const entry = catalog.find((asset) => (
    asset.id === document.assetId && asset.version === document.assetVersion
  ));
  if (entry === undefined) {
    const available = catalog.map((asset) => `${asset.id}@${asset.version}`).join(", ");
    throw new BuildScopeError(
      `The scene's asset ${document.assetId}@${document.assetVersion} has no package in assets/catalog.json (available: ${available}). Select a catalog asset before building.`,
    );
  }
  return {
    assetId: entry.id,
    packageDirectory: dirname(catalogRepoPath(entry.manifest, "manifest")),
    artifacts: {
      isaac: catalogRepoPath(entry.simulator.isaac, "simulator.isaac"),
      mujoco: catalogRepoPath(entry.simulator.mujoco, "simulator.mujoco"),
      unreal: catalogRepoPath(entry.simulator.unreal, "simulator.unreal"),
    },
  };
}

function buildDefinition(target: BuildTarget, buildPackage: BuildPackage): BuildDefinition {
  const { packageDirectory } = buildPackage;
  switch (target) {
    case "isaac":
      return {
        target,
        package: buildPackage,
        executable: "uv",
        displayExecutable: "uv",
        arguments: [
          "run",
          "--with",
          "usd-core",
          "--no-project",
          "python",
          bun.env.ISAAC_EXPORT_SCRIPT?.trim() || `${packageDirectory}/export_isaac.py`,
        ],
        artifact: bun.env.ISAAC_ARTIFACT?.trim() || buildPackage.artifacts.isaac,
      };
    case "mujoco": {
      const script = bun.env.MUJOCO_EXPORT_SCRIPT?.trim()
        || `${packageDirectory}/export_mujoco.py`;
      const artifact = bun.env.MUJOCO_ARTIFACT?.trim() || buildPackage.artifacts.mujoco;
      const configuredPython = bun.env.MUJOCO_PYTHON?.trim();
      if (configuredPython) {
        return {
          target,
          package: buildPackage,
          executable: configuredPython,
          displayExecutable: configuredPython,
          arguments: [script],
          artifact,
        };
      }
      return {
        target,
        package: buildPackage,
        executable: "uv",
        displayExecutable: "uv",
        arguments: [
          "run",
          "--with",
          "mujoco",
          "--with",
          "numpy",
          "--no-project",
          "python",
          script,
        ],
        artifact,
      };
    }
    case "unreal":
      return {
        target,
        package: buildPackage,
        executable: bun.env.BLENDER_BIN?.trim() || KNOWN_BLENDER_PATH,
        displayExecutable: bun.env.BLENDER_BIN?.trim() || "blender",
        arguments: [
          "--background",
          "--factory-startup",
          "--python",
          bun.env.UNREAL_EXPORT_SCRIPT?.trim() || `${packageDirectory}/export_browser.py`,
        ],
        artifact: bun.env.UNREAL_ARTIFACT?.trim() || buildPackage.artifacts.unreal,
      };
  }
}

function childEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  const allowed = [
    "HOME",
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "XDG_CACHE_HOME",
    "UV_CACHE_DIR",
    "LANG",
    "LC_ALL",
  ] as const;
  for (const name of allowed) {
    const value = bun.env[name];
    if (value !== undefined) environment[name] = value;
  }
  if (environment.PATH === undefined) environment.PATH = "/usr/local/bin:/usr/bin:/bin";
  return environment;
}

async function resolveExecutable(executable: string): Promise<string | null> {
  if (executable.includes("/")) {
    if (!executable.startsWith("/")) return null;
    return (await bun.file(executable).exists()) ? executable : null;
  }
  return bun.which(executable);
}

function buildResultResponse(result: BuildResult, status: number): Response {
  return jsonResponse(result, status);
}

function failedBuild(definition: BuildDefinition, output: string, status: number): Response {
  return buildResultResponse(
    {
      ok: false,
      target: definition.target,
      assetId: definition.package.assetId,
      packageDirectory: definition.package.packageDirectory,
      exportsSceneEntities: false,
      command: commandFor(definition),
      output,
    },
    status,
  );
}

async function captureProcess(
  process: BunSubprocess,
  timeoutMs = BUILD_TIMEOUT_MS,
  maxOutputBytes = MAX_BUILD_OUTPUT_BYTES,
): Promise<CapturedProcess> {
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  let capturedBytes = 0;
  let oversized = false;
  let timedOut = false;
  let killed = false;

  const kill = (): void => {
    if (killed) return;
    killed = true;
    try {
      process.kill("SIGKILL");
    } catch {
      // The process may have exited between the state check and the kill request.
    }
  };

  const timeout = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);

  const drain = async (stream: ReadableStream<Uint8Array>, destination: Uint8Array[]): Promise<void> => {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        const remaining = maxOutputBytes - capturedBytes;
        if (value.byteLength > remaining) {
          if (remaining > 0) destination.push(value.slice(0, remaining));
          capturedBytes = maxOutputBytes;
          oversized = true;
          kill();
          await reader.cancel();
          return;
        }
        capturedBytes += value.byteLength;
        destination.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  };

  const stdout = drain(process.stdout, stdoutChunks);
  const stderr = drain(process.stderr, stderrChunks);
  const exitCode = await process.exited;
  const streamResults = await Promise.allSettled([stdout, stderr]);
  clearTimeout(timeout);
  const streamFailure = streamResults.find((result) => result.status === "rejected");
  if (streamFailure?.status === "rejected") throw streamFailure.reason;

  const decode = (chunks: Uint8Array[]): string => {
    const decoder = new TextDecoder();
    let text = "";
    for (const chunk of chunks) text += decoder.decode(chunk, { stream: true });
    return text + decoder.decode();
  };
  const stdoutText = decode(stdoutChunks);
  const stderrText = decode(stderrChunks);
  const separator = stdoutText.length > 0 && stderrText.length > 0 && !stdoutText.endsWith("\n") ? "\n" : "";

  return {
    exitCode,
    output: `${stdoutText}${separator}${stderrText}`,
    oversized,
    stdout: stdoutText,
    stderr: stderrText,
    timedOut,
  };
}

async function runBuild(target: BuildTarget): Promise<Response> {
  if (buildInProgress) {
    return apiError(409, "Another build is already running. Wait for it to finish before retrying.");
  }

  buildInProgress = true;
  try {
    let definition: BuildDefinition;
    try {
      definition = buildDefinition(target, await resolveBuildPackage(sceneStore.currentDocument()));
    } catch (error) {
      if (error instanceof BuildScopeError) return apiError(409, error.message);
      throw error;
    }
    let executable = await resolveExecutable(definition.executable);
    if (
      executable === null
      && target === "unreal"
      && !bun.env.BLENDER_BIN?.trim()
    ) {
      executable = bun.which("blender");
    }
    if (executable === null) {
      return failedBuild(
        definition,
        `Required executable is unavailable: ${definition.displayExecutable}`,
        503,
      );
    }

    let process: BunSubprocess;
    try {
      process = bun.spawn([executable, ...definition.arguments], {
        cwd: REPOSITORY_ROOT,
        env: childEnvironment(),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return failedBuild(definition, `Unable to start required executable: ${detail}`, 503);
    }

    let captured: CapturedProcess;
    try {
      captured = await captureProcess(process);
    } catch (error) {
      try {
        process.kill("SIGKILL");
      } catch {
        // The process may already have exited.
      }
      const detail = error instanceof Error ? error.message : String(error);
      return failedBuild(definition, `Build process monitoring failed: ${detail}`, 500);
    }
    if (captured.oversized) {
      return failedBuild(
        definition,
        `Build output exceeded the ${MAX_BUILD_OUTPUT_BYTES}-byte limit and the process was stopped.`,
        413,
      );
    }
    if (captured.timedOut) {
      return failedBuild(
        definition,
        `Build exceeded the ${BUILD_TIMEOUT_MS / 1000}-second time limit and was stopped.`,
        504,
      );
    }
    if (captured.exitCode !== 0) {
      const output = captured.output.trim().length > 0
        ? captured.output
        : `Build process exited with status ${captured.exitCode}.`;
      return failedBuild(definition, output, 500);
    }

    return buildResultResponse(
      {
        ok: true,
        target,
        assetId: definition.package.assetId,
        packageDirectory: definition.package.packageDirectory,
        exportsSceneEntities: false,
        command: commandFor(definition),
        output: captured.output,
        artifact: definition.artifact,
      },
      200,
    );
  } finally {
    buildInProgress = false;
  }
}

async function readRequestBody(request: Request, maximumBytes: number): Promise<string | null> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) return null;
  if (request.body === null) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const decoder = new TextDecoder();
  return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") + decoder.decode();
}

async function handleBuildRequest(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return apiError(405, "Method not allowed; use POST /api/build.", { Allow: "POST" });
  }
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return apiError(415, "POST /api/build requires Content-Type: application/json.");
  }

  const body = await readRequestBody(request, MAX_BUILD_REQUEST_BYTES);
  if (body === null) return apiError(413, `Request body exceeds the ${MAX_BUILD_REQUEST_BYTES}-byte limit.`);

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return apiError(400, "Request body must be valid JSON.");
  }
  if (typeof payload !== "object" || payload === null || !("target" in payload)) {
    return apiError(400, "Request body must be an object containing a build target.");
  }
  const keys = Object.keys(payload);
  if (keys.length !== 1 || keys[0] !== "target") {
    return apiError(400, "Request body may contain only the target field.");
  }
  if (!isBuildTarget(payload.target)) {
    return apiError(400, "Unknown build target. Expected isaac, mujoco, or unreal.");
  }
  return runBuild(payload.target);
}

async function parseJsonRequest(request: Request, maximumBytes: number): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new SceneRequestError("Request requires Content-Type: application/json.");
  }
  const body = await readRequestBody(request, maximumBytes);
  if (body === null) {
    throw new SceneRequestError(`Request body exceeds the ${maximumBytes}-byte limit.`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new SceneRequestError("Request body must be valid JSON.");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new SceneRequestError("Request body must be an object.");
  }
  return payload as Record<string, unknown>;
}

function sceneApiErrorResponse(error: unknown): Response {
  if (error instanceof SceneConflictError) {
    return jsonResponse({
      error: error.message,
      current: sceneStore.snapshot(),
    }, 409);
  }
  if (error instanceof SceneRequestError || error instanceof StudioDocumentValidationError) {
    return apiError(400, error.message);
  }
  console.error("Scene-control request failed", error);
  return apiError(500, "Scene-control request failed.");
}

/**
 * Browser heartbeat (sent every poll and whenever render errors change). Records the
 * viewer's render errors and returns the revision marker the browser polls for changes.
 */
async function handleViewerStatusRequest(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return apiError(405, "Method not allowed; use POST /api/scene/viewer-status.", { Allow: "POST" });
  }
  try {
    const payload = await parseJsonRequest(request, MAX_VIEWER_STATUS_REQUEST_BYTES);
    sceneStore.reportViewerStatus(payload.renderErrors);
    const marker: SceneRevisionMarker = {
      instanceId: SCENE_SERVER_INSTANCE_ID,
      revision: sceneStore.currentRevision,
    };
    return jsonResponse(marker);
  } catch (error) {
    return sceneApiErrorResponse(error);
  }
}

async function handleSceneDocumentRequest(request: Request): Promise<Response> {
  if (request.method === "GET") {
    const origin = request.headers.get("origin")?.toLowerCase() ?? "";
    return jsonResponse(
      sceneStore.snapshot(),
      200,
      APPROVED_ORIGINS[origin] === true
        ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
        : undefined,
    );
  }
  if (request.method !== "PUT") {
    return apiError(405, "Method not allowed; use GET or PUT /api/scene.", { Allow: "GET, PUT" });
  }
  try {
    const payload = await parseJsonRequest(request, MAX_SCENE_REQUEST_BYTES);
    return jsonResponse(await sceneStore.replace(payload.expectedRevision, payload.document));
  } catch (error) {
    return sceneApiErrorResponse(error);
  }
}

async function handleSceneCommandsRequest(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return apiError(405, "Method not allowed; use POST /api/scene/commands.", { Allow: "POST" });
  }
  try {
    const payload = await parseJsonRequest(request, MAX_SCENE_REQUEST_BYTES);
    return jsonResponse(await sceneStore.applyCommands(payload.expectedRevision, payload.commands));
  } catch (error) {
    return sceneApiErrorResponse(error);
  }
}

async function runScenePython(expectedRevision: unknown, script: unknown): Promise<Response> {
  if (!Number.isInteger(expectedRevision) || (expectedRevision as number) < 0) {
    throw new SceneRequestError("expectedRevision must be a nonnegative integer.");
  }
  if (typeof script !== "string" || script.trim().length === 0) {
    throw new SceneRequestError("script must be a non-empty string.");
  }
  if (new TextEncoder().encode(script).byteLength > MAX_PYTHON_SCRIPT_BYTES) {
    throw new SceneRequestError(`script exceeds the ${MAX_PYTHON_SCRIPT_BYTES}-byte limit.`);
  }
  const before = sceneStore.snapshot();
  if (before.revision !== expectedRevision) {
    throw new SceneConflictError(expectedRevision as number, before.revision);
  }
  if (pythonInProgress) {
    return apiError(409, "Another Python scene script is already running.");
  }
  const configuredPython = bun.env.SCENE_PYTHON?.trim() || "python3";
  const executable = await resolveExecutable(configuredPython);
  if (executable === null) {
    return apiError(503, `Python executable is unavailable: ${configuredPython}`);
  }

  pythonInProgress = true;
  try {
    const environment = childEnvironment();
    environment.PYTHONNOUSERSITE = "1";
    const process = bun.spawn(
      [executable, "-I", "-S", PYTHON_RUNNER_PATH],
      {
        cwd: STUDIO_DIRECTORY,
        env: environment,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      process.stdin.write(JSON.stringify({ scene: before.document, script }));
      process.stdin.end();
    } catch (error) {
      process.kill("SIGKILL");
      throw new Error("Unable to send the scene to Python.", { cause: error });
    }

    const captured = await captureProcess(
      process,
      PYTHON_TIMEOUT_MS,
      MAX_PYTHON_OUTPUT_BYTES,
    );
    if (captured.oversized) {
      return apiError(413, `Python output exceeded the ${MAX_PYTHON_OUTPUT_BYTES}-byte limit.`);
    }
    if (captured.timedOut) {
      return apiError(504, `Python scene script exceeded the ${PYTHON_TIMEOUT_MS / 1000}-second limit.`);
    }
    if (captured.exitCode !== 0) {
      return apiError(400, captured.output.trim() || `Python exited with status ${captured.exitCode}.`);
    }

    let result: unknown;
    try {
      result = JSON.parse(captured.stdout);
    } catch {
      throw new Error("Python scene runner returned invalid JSON.");
    }
    if (
      typeof result !== "object"
      || result === null
      || Array.isArray(result)
      || !(("scene" in result) && ("output" in result))
      || typeof result.output !== "string"
    ) {
      throw new Error("Python scene runner returned an invalid result.");
    }
    const committed = await sceneStore.replaceFromPython(expectedRevision, result.scene);
    const response: ScenePythonResult = { ...committed, output: result.output };
    return jsonResponse(response);
  } finally {
    pythonInProgress = false;
  }
}

async function handleScenePythonRequest(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return apiError(405, "Method not allowed; use POST /api/scene/python.", { Allow: "POST" });
  }
  try {
    const payload = await parseJsonRequest(request, MAX_PYTHON_REQUEST_BYTES);
    return await runScenePython(payload.expectedRevision, payload.script);
  } catch (error) {
    return sceneApiErrorResponse(error);
  }
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".obj": "model/obj",
  ".ply": "application/octet-stream",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".splat": "application/octet-stream",
  ".spz": "application/octet-stream",
  ".usdc": "application/octet-stream",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".xml": "application/xml; charset=utf-8",
};

function contentType(path: string): string {
  const filename = path.slice(path.lastIndexOf("/") + 1);
  const dot = filename.lastIndexOf(".");
  return dot < 0 ? "application/octet-stream" : CONTENT_TYPES[filename.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

function safeStaticPath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!decoded.startsWith("/") || decoded.includes("\\") || decoded.includes("\0")) return null;
  const segments = decoded.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  return segments.filter(Boolean).join("/");
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Serves `studio/dist` first, then repo `assets/` (catalog, package outputs and model
 * GLBs such as `/fr10/browser/fr10_home.glb`), then the SPA index for HTML requests.
 */
async function staticResponse(request: Request, pathname: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return apiError(405, "Method not allowed.", { Allow: "GET, HEAD" });
  }

  const relativePath = safeStaticPath(pathname);
  if (relativePath === null) return apiError(400, "Invalid static file path.");
  const requestedPath = relativePath.length === 0 ? "index.html" : relativePath;
  let servedPath = requestedPath;
  let immutable = false;
  let filePath: string;

  if (await isRegularFile(`${DIST_DIRECTORY}/${requestedPath}`)) {
    filePath = `${DIST_DIRECTORY}/${requestedPath}`;
    immutable = requestedPath.startsWith("assets/");
  } else if (await isRegularFile(`${ASSETS_DIRECTORY}/${requestedPath}`)) {
    filePath = `${ASSETS_DIRECTORY}/${requestedPath}`;
  } else {
    const acceptsHtml = request.headers.get("accept")?.split(",").some((value) => value.trim().startsWith("text/html")) ?? false;
    if (!acceptsHtml) return apiError(404, "Static file not found.");
    servedPath = "index.html";
    filePath = `${DIST_DIRECTORY}/index.html`;
    if (!(await isRegularFile(filePath))) return apiError(503, "Production bundle is unavailable; build studio/dist first.");
  }
  const file = bun.file(filePath);

  const headers = new Headers({
    "Content-Type": contentType(servedPath),
    "Content-Length": String(file.size),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  return new Response(request.method === "HEAD" ? null : file, { status: 200, headers });
}

const server = bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    const host = request.headers.get("host")?.toLowerCase() ?? "";
    if (APPROVED_HOSTS[host] !== true) {
      return apiError(421, "Unrecognized Host header.");
    }
    if (
      url.pathname.startsWith("/api/")
      && request.method !== "GET"
      && request.method !== "HEAD"
    ) {
      const origin = request.headers.get("origin")?.toLowerCase() ?? "";
      if (APPROVED_ORIGINS[origin] !== true) {
        return apiError(403, "Mutating API requests require an approved loopback Origin.");
      }
    }
    if (url.pathname === "/api/health") {
      if (request.method !== "GET") {
        return apiError(405, "Method not allowed; use GET /api/health.", { Allow: "GET" });
      }
      return jsonResponse({
        ok: true,
        buildInProgress,
        pythonInProgress,
        sceneRevision: sceneStore.currentRevision,
        viewer: sceneStore.viewerStatus(),
      });
    }
    if (url.pathname === "/api/build") return handleBuildRequest(request);
    if (url.pathname === "/api/scene/viewer-status") return handleViewerStatusRequest(request);
    if (url.pathname === "/api/scene/commands") return handleSceneCommandsRequest(request);
    if (url.pathname === "/api/scene/python") return handleScenePythonRequest(request);
    if (url.pathname === "/api/scene") return handleSceneDocumentRequest(request);
    if (url.pathname.startsWith("/api/")) return apiError(404, "API endpoint not found.");
    return staticResponse(request, url.pathname);
  },
  error(error): Response {
    console.error("Unhandled studio server error", error);
    return apiError(500, "Internal server error.");
  },
});

console.info(`Asset Studio server listening on http://${server.hostname}:${server.port}`);
