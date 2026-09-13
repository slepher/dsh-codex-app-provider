import z from "@deepseek-ai/schemastery";

export const SETTINGS_NAMESPACE = "dsh-codex-app-provider";
export const OPEN_POSITION_FIELD = "subagentOpenPosition";
export type SubagentOpenPosition = "sidebar" | "main";
export interface Settings { subagentOpenPosition: SubagentOpenPosition }
export const SettingsSchema: z<Settings> = z.object({
  subagentOpenPosition: z.union(["sidebar", "main"]).default("sidebar"),
});
