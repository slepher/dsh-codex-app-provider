/**
 * The ordinary Codex worker action surface.
 *
 * One `codex_workers` call is one action over workers owned by the calling
 * parent Session. The backend owns identity, ownership, state and report
 * durability; this module only names the actions and maps arguments onto it, so
 * a caller cannot reach a worker its Session does not own and cannot skip a
 * state precondition.
 * @module dsh-codex-app-provider/worker-actions
 */

import type { Caller, CodexBackend, ReportAcceptance, TurnInput } from "./browser-types.js";

/** The actions `codex_workers` accepts. */
export type WorkerActionName =
  | "create" | "list" | "get" | "reports" | "append" | "steer" | "interrupt" | "resume" | "accept" | "ack" | "close";

/** One ordinary delegation request. */
export interface WorkerAction {
  action: WorkerActionName;
  workerId?: string;
  name?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  text?: string;
  turnId?: string;
  acceptance?: ReportAcceptance;
  skills?: readonly TurnInput[];
}

/** The fields each action reads; anything else in a call is the caller's mistake. */
const ACTION_FIELDS: Readonly<Record<WorkerActionName, readonly (keyof WorkerAction)[]>> = {
  list: [],
  reports: [],
  create: ["workerId", "name", "cwd", "model", "effort"],
  get: ["workerId"],
  append: ["workerId", "text", "skills"],
  steer: ["workerId", "turnId", "text", "skills"],
  interrupt: ["workerId", "turnId"],
  resume: ["workerId"],
  ack: ["workerId", "turnId"],
  accept: ["workerId", "turnId", "acceptance"],
  close: ["workerId"],
};

/**
 * Reject arguments the chosen action never reads.
 *
 * A silently ignored field is worse than a refusal: `reports` once ignored a
 * `workerId` and answered with an empty list, which reads like "this worker has
 * reported nothing yet" and sends the caller away to wait instead of correcting
 * the call. Every action here reads a known set, so a stray field is named.
 * @param action - the action being executed.
 * @param input - the call's arguments.
 * @param accepted - the field names this action reads.
 * @throws when the call carries a field outside `accepted`.
 */
function assertActionFields(action: WorkerActionName, input: WorkerAction, accepted: readonly (keyof WorkerAction)[]): void {
  const fields = input as unknown as Record<string, unknown>;
  const extra = Object.keys(input).filter(field => field !== "action"
    && fields[field] !== undefined
    && !accepted.includes(field as keyof WorkerAction));
  if (extra.length === 0) return;
  const reads = accepted.length === 0 ? "no other fields" : accepted.map(field => `"${field}"`).join(", ");
  throw new Error(`codex_workers "${action}" does not read ${extra.map(field => `"${field}"`).join(", ")}; it reads ${reads}`);
}

/**
 * Execute one worker action against the backend.
 * @param backend - the single Codex backend that owns worker records.
 * @param caller - the contextual caller derived from the live parent Agent.
 * @param parentCwd - the parent Session's workspace, used when a create omits one.
 * @param input - the validated action arguments.
 * @param revalidate - asked to re-prove the parent identity before each mutation.
 * @returns the action's canonical result, JSON-serializable.
 * @throws when a required field is missing, an unread field is present, or the backend refuses the action.
 */
export async function executeWorkerAction(
  backend: CodexBackend,
  caller: Caller,
  parentCwd: string,
  input: WorkerAction,
  revalidate: () => void = () => {},
): Promise<unknown> {
  const accepted = Object.hasOwn(ACTION_FIELDS, input.action) ? ACTION_FIELDS[input.action] : undefined;
  if (accepted === undefined) throw new Error("Unknown worker action");
  assertActionFields(input.action, input, accepted);
  switch (input.action) {
    case "list": return backend.listWorkers(caller);
    case "reports": return backend.pendingReports(caller);
    case "create": {
      revalidate();
      return backend.createWorker(caller, {
        ...(input.workerId === undefined ? {} : { id: input.workerId }),
        name: required(input.name, "name"),
        cwd: input.cwd ?? parentCwd,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.effort === undefined ? {} : { reasoningEffort: input.effort }),
      });
    }
  }
  const workerId = required(input.workerId, "workerId");
  switch (input.action) {
    case "get": return backend.getWorker(caller, workerId);
    case "append": {
      const worker = await backend.getWorker(caller, workerId);
      if (worker.state !== "idle") throw new Error(`Worker is ${worker.state}; use steer for an active turn`);
      revalidate();
      await backend.startTurn(caller, workerId, turnInput(required(input.text, "text"), input.skills));
      return { worker: await backend.getWorker(caller, workerId) };
    }
    case "steer":
      revalidate();
      await backend.steerTurn(caller, workerId, required(input.turnId, "turnId"), turnInput(required(input.text, "text"), input.skills));
      return backend.getWorker(caller, workerId);
    case "interrupt":
      revalidate();
      await backend.interruptTurn(caller, workerId, required(input.turnId, "turnId"));
      return backend.getWorker(caller, workerId);
    case "resume":
      revalidate();
      await backend.resumeSession(caller, workerId);
      return backend.getWorker(caller, workerId);
    case "ack":
      revalidate();
      return backend.acknowledgeReport(caller, workerId, required(input.turnId, "turnId"));
    case "accept":
      revalidate();
      return backend.acceptReport(caller, workerId, required(input.turnId, "turnId"), acceptance(input.acceptance));
    case "close":
      revalidate();
      await backend.closeSession(caller, workerId);
      return { id: workerId, closed: true };
    default: throw new Error("Unknown worker action");
  }
}

/** One turn's input: the task text, followed by any native skill bindings. */
function turnInput(text: string, skills: readonly TurnInput[] | undefined): string | readonly TurnInput[] {
  return skills !== undefined && skills.length > 0 ? [{ type: "text", text }, ...skills] : text;
}

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function acceptance(value: unknown): ReportAcceptance {
  if (value === "pending" || value === "accepted" || value === "changes-requested") return value;
  throw new Error("Invalid report acceptance");
}
