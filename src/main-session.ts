/**
 * Withdraw the route from main Sessions without leaving DSH pointing at it.
 *
 * When `allowMainSession` is off, the codex-app route disappears from the model
 * catalog. A saved global default or an open Session can still hold that
 * selection, and the Host then degrades to "Select model" and blocks input. The
 * plugin that withdrew the route puts those references back on a route that can
 * serve them; it never touches a managed child, whose model is its execution
 * input rather than a user choice.
 * @module dsh-codex-app-provider/main-session
 */

import type { ModelSelection } from "@deepseek-ai/dsh-agent";
import type { Session, SessionId } from "@deepseek-ai/dsh-session";

import { CODEX_APP_PROVIDER } from "./browser-types.js";
import { readExecutionInputs } from "./execution-inputs.js";

/**
 * The Host's own model-selection event, declared here because its declaring
 * package (`@deepseek-ai/dsh-api-session-controller`) is not a dependency of
 * this plugin: the event is the one the Host's `selectModel` appends, and this
 * module emits the identical event to release a withdrawn route.
 */
declare module "@deepseek-ai/dsh-session/types" {
  interface SessionEventMap {
    "model/selection": ModelSelection;
  }
}

/** Provider routes preferred as the replacement, in order; any other route follows. */
const PREFERRED_ROUTES = ["deepseek-account", "deepseek-official"];

/** The projection state the Host keeps for a Session's model selection. */
interface SelectionState {
  lastUsed?: { provider?: unknown } | null;
  pending?: { provider?: unknown } | null;
}

/** The optional `agentDefaultModel` service face this module reads structurally. */
export interface DefaultModelFace {
  currentSelection(): ModelSelection;
  saveSelection(next: ModelSelection): Promise<void>;
}

/** The optional `sessionProjections` service face this module reads structurally. */
export interface ProjectionsFace {
  stateOf(session: Session, key: string): unknown;
}

/** The injected capabilities one retirement pass needs; absent ones are skipped, not fatal. */
export interface MainSessionRetirementDeps {
  llm: {
    listProviders(): readonly { id: string }[];
    listModels(provider: string): Promise<readonly { id: string }[]>;
  };
  sessions: { list(): readonly Session[] };
  agents?: { get(id: SessionId): { options: unknown } | undefined } | undefined;
  projections?: ProjectionsFace | undefined;
  defaultModel?: DefaultModelFace | undefined;
  /** Where a skipped step is reported; never throws. */
  log(message: string): void;
}

/**
 * Choose a replacement route and model: the preferred routes first, then any
 * other advertised provider. A provider whose catalog read fails is skipped
 * without ending the search, because one broken adapter must not keep the
 * deployment stuck on a hidden route.
 * @param llm - the LLM registry.
 * @returns the replacement selection, or `undefined` when no route serves one.
 */
export async function fallbackSelection(
  llm: MainSessionRetirementDeps["llm"],
): Promise<ModelSelection | undefined> {
  const routes = llm.listProviders().map(provider => provider.id).filter(id => id !== CODEX_APP_PROVIDER);
  const ordered = [
    ...PREFERRED_ROUTES.filter(id => routes.includes(id)),
    ...routes.filter(id => !PREFERRED_ROUTES.includes(id)),
  ];
  for (const provider of ordered) {
    try {
      const models = await llm.listModels(provider);
      const model = models[0];
      if (model !== undefined) return { provider, model: model.id };
    } catch {
      // A route that cannot answer its catalog is not a fallback.
    }
  }
  return undefined;
}

/**
 * Point the global default and every open top-level Session away from this
 * route. Idempotent: a later pass sees the rewritten selection and does nothing.
 * @param deps - the capabilities one pass reads; missing optional seams are skipped.
 * @returns whether any reference was rewritten.
 */
export async function retireMainSessionSelection(deps: MainSessionRetirementDeps): Promise<boolean> {
  let changed = false;
  const selection = await fallbackSelection(deps.llm);
  if (selection === undefined) {
    deps.log("no other model route can replace the codex-app selection; leaving the saved selection untouched");
    return false;
  }
  if (deps.defaultModel !== undefined) {
    try {
      if (deps.defaultModel.currentSelection().provider === CODEX_APP_PROVIDER) {
        await deps.defaultModel.saveSelection(selection);
        changed = true;
      }
    } catch (error) {
      deps.log(`the global default model was not replaced: ${messageOf(error)}`);
    }
  }
  if (deps.projections === undefined) {
    deps.log("session projections are unavailable; open Sessions keep their recorded selection until the Host re-selects");
    return changed;
  }
  for (const session of deps.sessions.list()) {
    if (managedChild(session, deps.agents)) continue;
    const state = deps.projections.stateOf(session, "modelSelection") as SelectionState | undefined;
    const current = state?.pending ?? state?.lastUsed;
    if (current?.provider !== CODEX_APP_PROVIDER) continue;
    try {
      session.append("model/selection", selection);
      changed = true;
    } catch (error) {
      deps.log(`a Session kept its codex-app selection: ${messageOf(error)}`);
    }
  }
  return changed;
}

/** Whether one Session runs as a managed child, whose model is an execution input. */
function managedChild(session: Session, agents: MainSessionRetirementDeps["agents"]): boolean {
  const agent = agents?.get(session.id);
  if (agent === undefined) return false;
  try {
    return readExecutionInputs(agent.options) !== undefined;
  } catch {
    return false;
  }
}

/** A message from any thrown value. */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
