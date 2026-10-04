import assert from "node:assert/strict";
import test from "node:test";

import { count, normalizeUsage, usageChunk, usageContextWindow } from "../lib/usage.js";

/** The App Server's camelCase spelling of one complete token payload. */
const camel = {
  total: { totalTokens: 100, inputTokens: 60, cachedInputTokens: 20, cacheWriteInputTokens: 5, outputTokens: 40, reasoningOutputTokens: 7 },
  last: { totalTokens: 30, inputTokens: 20, cachedInputTokens: 8, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 },
  modelContextWindow: 200,
  currentContextTokens: 30,
};

test("count accepts only non-negative safe integers", () => {
  assert.equal(count(0), 0);
  assert.equal(count(-1), null);
  assert.equal(count(1.5), null);
  assert.equal(count("12"), null);
  assert.equal(count(Number.MAX_SAFE_INTEGER + 1), null);
  assert.equal(count(undefined), null);
});

test("normalizeUsage reads both spellings and derives the remaining context ratio", () => {
  const usage = normalizeUsage(camel);
  assert.deepEqual(usage.total, {
    totalTokens: 100, inputTokens: 60, cachedInputTokens: 20,
    cacheWriteInputTokens: 5, outputTokens: 40, reasoningOutputTokens: 7,
  });
  assert.deepEqual(usage.last, {
    totalTokens: 30, inputTokens: 20, cachedInputTokens: 8,
    cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0,
  });
  assert.equal(usage.modelContextWindow, 200);
  assert.equal(usage.currentContextTokens, 30);
  assert.equal(usage.remainingContextRatio, 1 - 30 / 200);

  // The released wire spelling was snake_case, field by field.
  const snake = normalizeUsage({ total: { total_tokens: 2, input_tokens: 1 }, last: { output_tokens: 1 } });
  assert.equal(snake.total.totalTokens, 2);
  assert.equal(snake.total.inputTokens, 1);
  assert.equal(snake.last.outputTokens, 1);
});

test("normalizeUsage keeps an unreported field null instead of inventing a zero", () => {
  const usage = normalizeUsage({ last: { inputTokens: 4 } });
  assert.equal(usage.last.inputTokens, 4);
  assert.equal(usage.last.outputTokens, null, "not reported is not zero");
  assert.equal(usage.modelContextWindow, null);
  assert.equal(usage.remainingContextRatio, null, "no context window means no ratio");
  assert.equal(normalizeUsage(null), null);
  assert.equal(normalizeUsage("none"), null);
});

test("normalizeUsage falls back to the last total for the current context", () => {
  const usage = normalizeUsage({ last: { totalTokens: 50 }, modelContextWindow: 100 });
  assert.equal(usage.currentContextTokens, 50);
  assert.equal(usage.remainingContextRatio, 0.5);
});

test("usageChunk bills only the uncached input", () => {
  const chunk = usageChunk(normalizeUsage(camel));
  assert.deepEqual(chunk, {
    inputTokens: 12, // 20 input, 8 of them cached and already inside the input count
    outputTokens: 10,
    totalTokens: 30,
    cacheReadTokens: 8,
    // cacheWrite and reasoning are both zero, so neither is reported
  });
});

test("usageChunk reports nothing for a turn whose accounting never arrived", () => {
  assert.equal(usageChunk(null), undefined);
  assert.equal(usageChunk(normalizeUsage({ last: {} })), undefined, "neither input nor output was reported");
  // One reported side is enough; the other becomes zero.
  assert.deepEqual(usageChunk(normalizeUsage({ last: { outputTokens: 3 } })), { inputTokens: 0, outputTokens: 3 });
});

test("usageContextWindow accepts only a positive safe integer", () => {
  assert.equal(usageContextWindow({ modelContextWindow: 1000 }), 1000);
  assert.equal(usageContextWindow({ modelContextWindow: 0 }), undefined);
  assert.equal(usageContextWindow({}), undefined);
  assert.equal(usageContextWindow(null), undefined);
});
