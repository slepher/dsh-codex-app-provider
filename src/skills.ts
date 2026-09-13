import type { Skill } from "./browser-types.js";

export async function listSkills(query: (method: string, params: unknown) => Promise<any>, cwd: string): Promise<Skill[]> {
  const result = await query("skills/list", { cwds: [cwd], forceReload: true });
  const entries = (result.data ?? []).filter((entry: any) => entry.cwd === cwd);
  const errors = entries.flatMap((entry: any) => entry.errors ?? []);
  if (errors.length) throw new Error(errors.map((error: any) => `${error.path}: ${error.message}`).join("\n"));
  return entries.flatMap((entry: any) => entry.skills ?? []).filter((skill: any) => skill.enabled).map(({ name, path, description }: Skill) => ({ name, path, description }));
}

export function resolveSkills(text: string, catalog: readonly Skill[], selected: readonly Skill[] = []): Skill[] {
  if (!Array.isArray(selected)) throw new Error("Invalid skill selection");
  const result = selected.map(skill => {
    const match = catalog.find(value => value.name === skill?.name && value.path === skill?.path);
    if (match === undefined) throw new Error("Selected skill is unavailable; select it again");
    return match;
  });
  for (const name of new Set([...text.matchAll(/(?:^|\s)\$([\w:-]+)(?=\s|$|[.,!?，。！？])/g)].map(match => match[1]))) {
    if (result.some(skill => skill.name === name)) continue;
    const matches = catalog.filter(skill => skill.name === name);
    if (matches.length > 1) throw new Error(`Skill $${name} is ambiguous; select it from the menu`);
    if (matches.length === 1) result.push(matches[0]);
  }
  return [...new Map(result.map(skill => [skill.path, skill])).values()];
}
