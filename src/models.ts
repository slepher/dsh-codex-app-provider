import type { ModelSettings } from "./browser-types.js";

export async function modelSettings(query: (method: string, params: unknown) => Promise<any>, cwd: string): Promise<ModelSettings> {
  const { config = {} } = await query("config/read", { includeLayers: false, cwd });
  const models: any[] = [];
  let cursor: string | null = null;
  do {
    const page = await query("model/list", { cursor, limit: 100, cwd });
    models.push(...(page.data ?? []));
    cursor = page.nextCursor ?? null;
  } while (cursor !== null);
  const model = config.model ?? models.find(value => value.isDefault)?.model ?? null;
  const contextWindow = Number.isSafeInteger(config.model_context_window) && config.model_context_window > 0 ? config.model_context_window : undefined;
  return {
    models: models.map(({ model, displayName, supportedReasoningEfforts, defaultReasoningEffort, inputModalities }) => ({
      model,
      displayName,
      supportedReasoningEfforts,
      defaultReasoningEffort,
      ...(Array.isArray(inputModalities)
        ? { inputModalities: inputModalities.filter((value: unknown) => value === "text" || value === "image") }
        : {}),
    })),
    model,
    effort: config.model_reasoning_effort ?? models.find(value => value.model === model)?.defaultReasoningEffort ?? null,
    ...(contextWindow === undefined ? {} : { contextWindow }),
  };
}
