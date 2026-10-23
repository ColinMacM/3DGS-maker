import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { resolve } from "node:path";

const STUDIO_DIRECTORY = resolve(import.meta.dirname, "../..");
const REPOSITORY_ROOT = resolve(STUDIO_DIRECTORY, "..");
/** `server.ts` always binds here, so only this origin can be started locally. */
const LOCAL_SCENE_ORIGINS: Record<string, true> = { "http://127.0.0.1:4174": true, "http://localhost:4174": true };
export const SCENE_SERVER_LOG_PATH = resolve(REPOSITORY_ROOT, ".asset-studio/scene-server.log");

/**
 * Returns a starter for the scene API when `origin` is the local default and
 * `SCENE_STUDIO_AUTOSTART` is not `0`; otherwise `undefined` (connect only).
 *
 * The API runs detached from the MCP process so the browser and other MCP
 * clients keep using it after this client exits. Output goes to
 * `.asset-studio/scene-server.log`.
 */
export function localSceneServerStarter(origin: string): (() => Promise<void>) | undefined {
  if (process.env.SCENE_STUDIO_AUTOSTART === "0" || !LOCAL_SCENE_ORIGINS[origin]) return undefined;
  return async () => {
    mkdirSync(resolve(REPOSITORY_ROOT, ".asset-studio"), { recursive: true });
    const log = openSync(SCENE_SERVER_LOG_PATH, "a");
    const child = spawn(process.execPath, ["run", "server.ts"], {
      cwd: STUDIO_DIRECTORY,
      detached: true,
      stdio: ["ignore", log, log],
    });
    child.unref();
    console.error(`asset-studio-scene: started scene API (pid ${child.pid}); log ${SCENE_SERVER_LOG_PATH}`);
  };
}
