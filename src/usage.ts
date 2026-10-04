/**
 * The App Server's token accounting in DSH's vocabulary.
 *
 * Two directions, one module. `normalizeUsage` reads a raw native payload into
 * the plugin's own record shape (what the backend stores per report), and
 * `usageChunk` projects that record onto the `TokenUsage` a DSH stream reports.
 * Both are pure: no backend handle, no process, no Host capability.
 * @module dsh-codex-app-provider/usage
 */

import type { TokenUsage } from "@deepseek-ai/dsh-llm";

import type { Usage, UsageValues } from "./browser-types.js";

/** The App Server's camelCase and legacy snake_case spellings of one count. */
function tokenValues(value: any): UsageValues {
  return {
    totalTokens: count(value?.totalTokens ?? value?.total_tokens),
    inputTokens: count(value?.inputTokens ?? value?.input_tokens),
    cachedInputTokens: count(value?.cachedInputTokens ?? value?.cached_input_tokens),
    cacheWriteInputTokens: count(value?.cacheWriteInputTokens ?? value?.cache_write_input_tokens),
    outputTokens: count(value?.outputTokens ?? value?.output_tokens),
    reasoningOutputTokens: count(value?.reasoningOutputTokens ?? value?.reasoning_output_tokens),
  };
}

/** One wire count: a non-negative safe integer, or `null` for anything else. */
export function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Read one native usage payload into the recorded shape.
 *
 * Every field is `null` when the App Server did not report it, so a reader can
 * tell "zero tokens" from "not reported" instead of seeing an invented zero.
 * @param value - the raw `thread/tokenUsage/updated` payload, when one arrived.
 * @returns the normalized usage, or `null` when the value is not a payload.
 */
export function normalizeUsage(value: unknown): Usage | null {
  if (typeof value !== "object" || value === null) return null;
  const usage = value as Record<string, any>;
  const total = tokenValues(usage.total);
  const last = tokenValues(usage.last);
  const modelContextWindow = count(usage.modelContextWindow);
  const currentContextTokens = count(usage.currentContextTokens ?? usage.last?.totalTokens);
  return {
    total,
    last,
    modelContextWindow,
    currentContextTokens,
    remainingContextRatio: currentContextTokens !== null && modelContextWindow !== null && modelContextWindow > 0
      ? Math.max(0, 1 - currentContextTokens / modelContextWindow)
      : null,
  };
}

/** The last confirmed context window a recorded usage carries, when it is one. */
export function usageContextWindow(usage: unknown): number | undefined {
  if (typeof usage !== "object" || usage === null) return undefined;
  const value = (usage as { modelContextWindow?: unknown }).modelContextWindow;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * Project one recorded turn's usage onto the chunk DSH reports.
 *
 * `inputTokens` is billed input minus the cached prefix: Codex reports cached
 * tokens inside its input count, and DSH accounts for them separately through
 * `cacheReadTokens`, so passing the raw count would bill those tokens twice. A
 * turn whose accounting never arrived reports nothing rather than a zero meter.
 * @param usage - the report's usage, or `null` when native reported none.
 * @returns the chunk, or `undefined` when there is nothing truthful to report.
 */
export function usageChunk(usage: Usage | null): TokenUsage | undefined {
  if (usage === null) return undefined;
  const last = usage.last;
  const cached = last.cachedInputTokens ?? 0;
  const input = last.inputTokens === null ? null : Math.max(0, last.inputTokens - cached);
  if (input === null && last.outputTokens === null) return undefined;
  const output = last.outputTokens ?? 0;
  return {
    inputTokens: input ?? 0,
    outputTokens: output,
    ...(last.totalTokens === null ? {} : { totalTokens: last.totalTokens }),
    ...(cached === 0 ? {} : { cacheReadTokens: cached }),
    ...(last.cacheWriteInputTokens === null || last.cacheWriteInputTokens === 0 ? {} : { cacheWriteTokens: last.cacheWriteInputTokens }),
    ...(last.reasoningOutputTokens === null || last.reasoningOutputTokens === 0 ? {} : { reasoningTokens: last.reasoningOutputTokens }),
  };
}
