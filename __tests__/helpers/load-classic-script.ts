import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

/**
 * Loads an extension module (classic service-worker script — loaded via
 * importScripts in prod, no ES-module wrapper) into a fresh vm sandbox
 * and returns the sandbox's globals as the given type.
 *
 * Each call creates a new sandbox, so module-scoped state is isolated
 * per-caller. Use this in test files that need to exercise the actual
 * extension source rather than a parallel TypeScript port.
 */
export function loadClassicScript<T extends Record<string, unknown>>(
  relativePath: string,
): T {
  const src = readFileSync(
    path.resolve(process.cwd(), relativePath),
    "utf8",
  );
  const sandbox: Record<string, unknown> = {};
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox as T;
}
