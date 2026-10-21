/**
 * Wire types shared by the Host probe and the browser settings page.
 *
 * Kept free of runtime imports so the client half can read them without pulling
 * any Node-only module into the browser program.
 * @module dsh-codex-app-provider/check-types
 */

/** Where the resolved program came from, for diagnostics. */
export type CheckedCommandSource = "configured" | "path" | "native" | "npm-shim" | "fallback";

/** The command facts one availability check reports. */
export interface CheckedCommand {
  program: string;
  prefixArgs: string[];
  source: CheckedCommandSource;
}

/** One availability answer as the browser renders it. */
export interface CodexAvailability {
  /** Epoch milliseconds of the check that produced this answer. */
  checkedAt: number;
  command: CheckedCommand;
  /** The CLI's own `--version` output, when it ran. */
  version?: string;
  /** Model ids the installed App Server advertises, when the catalog read succeeded. */
  models?: string[];
  /** Why the check could not complete, when it could not. */
  error?: string;
}
