/**
 * Plugin-owned native execution inputs.
 *
 * Stock DSH core neither fills `GenerateOptions.execution` nor exports the
 * core's `executionOptionsEqual`, so the provider cannot depend on either. It
 * reads the two fields it actually enforces structurally from the request or
 * from the live Agent's creation snapshot, and compares them here. Only
 * `developerInstructions` and `boundary` are execution inputs; the rest of the
 * backend options is not.
 *
 * A declared `boundary` is a task-level constraint: it is forwarded to Codex
 * verbatim, `<boundary.cwd>` is the native thread's working directory, and the
 * plugin never synthesizes, widens or narrows it.
 * @module dsh-codex-app-provider/execution-inputs
 */

import type { ExecutionBoundary } from "./browser-types.js";

/** Developer instructions plus the native boundary actually applied to one Session. */
export interface ProviderExecutionInputs {
  developerInstructions?: string;
  boundary?: ExecutionBoundary;
}

/**
 * Detach one declared boundary from its owner.
 *
 * `AgentOptions` composition spreads a caller's object shallowly, so a nested
 * `boundary` stays the caller's own reference: a later mutation of the caller's
 * `writableRoots` would otherwise rewrite what this Session recorded and what a
 * later request is compared against. The provider reads its own snapshot so an
 * execution's inputs are fixed the moment they are observed.
 * @param boundary - the declared boundary, already structurally validated.
 * @returns an independent boundary value.
 */
function snapshotBoundary(boundary: ExecutionBoundary): ExecutionBoundary {
  return { cwd: boundary.cwd, writableRoots: [...boundary.writableRoots], network: boundary.network };
}

function isBoundary(value: unknown): value is ExecutionBoundary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const boundary = value as { cwd?: unknown; writableRoots?: unknown; network?: unknown };
  return typeof boundary.cwd === "string" && boundary.cwd.length > 0
    && Array.isArray(boundary.writableRoots) && boundary.writableRoots.every(root => typeof root === "string")
    && (boundary.network === "disabled" || boundary.network === "loopback");
}

/**
 * Read plugin-owned execution inputs from a request or an `AgentOptions` value.
 *
 * The field is absent from the stock types, so the read is structural; a
 * present but malformed value fails closed instead of silently dropping the
 * instructions or the boundary.
 * @param carrier - the request or Agent creation options that may carry `execution`.
 * @returns the declared inputs, or undefined when the carrier declares none.
 * @throws when a declared `execution` value is not a valid inputs object.
 */
export function readExecutionInputs(carrier: unknown): ProviderExecutionInputs | undefined {
  if (typeof carrier !== "object" || carrier === null) return undefined;
  const value = (carrier as { execution?: unknown }).execution;
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Native execution inputs must be an object");
  }
  const record = value as { developerInstructions?: unknown; boundary?: unknown };
  if (record.developerInstructions !== undefined && typeof record.developerInstructions !== "string") {
    throw new Error("Native execution developer instructions must be a string");
  }
  if (record.boundary !== undefined && !isBoundary(record.boundary)) {
    throw new Error("Native execution boundary is malformed");
  }
  return {
    ...(record.developerInstructions === undefined ? {} : { developerInstructions: record.developerInstructions }),
    ...(record.boundary === undefined ? {} : { boundary: snapshotBoundary(record.boundary) }),
  };
}

/** Compare execution inputs independently of JSON property insertion order. */
export function executionInputsEqual(
  a: ProviderExecutionInputs | undefined,
  b: ProviderExecutionInputs | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.developerInstructions !== b.developerInstructions) return false;
  const x = a.boundary, y = b.boundary;
  if (x === undefined || y === undefined) return x === y;
  return x.cwd === y.cwd && x.network === y.network
    && x.writableRoots.length === y.writableRoots.length
    && x.writableRoots.every((root, index) => root === y.writableRoots[index]);
}

/**
 * The native execution cwd one Session's thread runs in.
 *
 * A declared task boundary names the real working location (a lane, an
 * allocated worktree); without one the thread runs in the Session's own host
 * workspace. The two are deliberately different values and are persisted
 * separately so a lane worker is never mistaken for a workspace change.
 * @param inputs - the declared execution inputs, when any.
 * @param sessionCwd - the DSH Session's host workspace.
 * @returns the absolute directory the Codex thread runs in.
 */
export function executionCwd(inputs: ProviderExecutionInputs | undefined, sessionCwd: string): string {
  return inputs?.boundary?.cwd ?? sessionCwd;
}
