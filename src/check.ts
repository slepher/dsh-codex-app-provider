/**
 * One availability check for the Codex CLI, cached after the first run.
 *
 * The check answers "can this deployment start Codex, and which models does the
 * installed CLI advertise": it resolves the executable the same way the App
 * Server does, runs `--version`, and reads the App Server's model catalog. The
 * answer is cached for the life of the plugin instance, so reopening the
 * settings page costs nothing; the page's explicit button forces a refresh.
 * @module dsh-codex-app-provider/check
 */

import { execFile } from "node:child_process";

import { resolveCodexCommand } from "./command.js";
import type { CodexAvailability } from "./check-types.js";

export type { CheckedCommand, CodexAvailability } from "./check-types.js";

/** Inputs of one check; the side effects are injectable for tests. */
export interface AvailabilityProbeDeps {
  /** The live configured `command`; blank means auto-detect. */
  configured: () => string | undefined;
  /** Reads the App Server's model ids through the provider's own transport. */
  listModels?: () => Promise<string[]>;
  /** Runs `<program> --version`; defaults to a hidden child process. */
  runVersion?: (command: ResolvedCommand) => Promise<string>;
  /** Clock; defaults to `Date.now`. */
  now?: () => number;
}

/** The executable pair a version read needs. */
interface ResolvedCommand {
  program: string;
  prefixArgs: string[];
}

/**
 * Build the cached probe.
 *
 * `force: false` returns the previous answer when one exists; `force: true`
 * always re-resolves and re-spawns.
 * @param deps - live configuration and injectable side effects.
 * @returns the probe function the RPC route calls.
 */
export function createAvailabilityProbe(deps: AvailabilityProbeDeps): (force: boolean) => Promise<CodexAvailability> {
  let cached: CodexAvailability | undefined;
  return async (force: boolean): Promise<CodexAvailability> => {
    if (!force && cached !== undefined) return cached;
    const resolved = resolveCodexCommand({ configured: deps.configured() });
    const result: CodexAvailability = {
      checkedAt: (deps.now ?? Date.now)(),
      command: { program: resolved.program, prefixArgs: resolved.prefixArgs, source: resolved.source },
    };
    try {
      result.version = await (deps.runVersion ?? runVersion)(resolved);
    } catch (error) {
      result.error = `the Codex CLI could not run: ${messageOf(error)}`;
      cached = result;
      return result;
    }
    if (deps.listModels !== undefined) {
      try {
        result.models = await deps.listModels();
      } catch (error) {
        // The CLI runs, so this is a catalog failure rather than a broken install.
        result.error = `the model catalog could not be read: ${messageOf(error)}`;
      }
    }
    cached = result;
    return result;
  };
}

/** Run one executable's `--version`, hidden from the desktop on Windows. */
function runVersion(command: ResolvedCommand): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command.program, [...command.prefixArgs, "--version"], { timeout: 15_000, windowsHide: true }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(stderr.trim() === "" ? String(error.message) : stderr.trim()));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/** A message from any thrown value. */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
