/**
 * Firing a saved skill from the composer: prompt for declared/{{placeholder}}
 * inputs, substitute them, and hand the resulting instruction to the agent.
 * Shared by the "+" menu and the "/" slash menu.
 */
export interface Skill {
  id: string;
  name: string;
  description?: string;
  inputs?: string[];
  steps?: string[];
}
export interface AgentCommand { name: string; description?: string }

export function runText(text: string) {
  window.dispatchEvent(new CustomEvent('pilot:run', { detail: text }));
}

/** Build the instruction to run a skill, prompting for its inputs. Null if cancelled. */
export function skillToRunText(s: Skill): string | null {
  const inputs = (s.steps ?? [])
    .flatMap((x) => Array.from(x.matchAll(/\{\{\s*([a-z0-9_ -]+)\s*\}\}/gi), (m) => m[1]!.trim()))
    .filter((v, i, a) => a.indexOf(v) === i)
    .filter((v) => !(s.inputs ?? []).includes(v));
  const values: Record<string, string> = {};
  for (const name of s.inputs ?? []) {
    const v = window.prompt(`Value for "${name}":`, '');
    if (v == null) return null;
    values[name] = v;
  }
  for (const name of inputs) {
    const v = window.prompt(`Value for "${name}" (used by the skill):`, '');
    if (v == null) return null;
    values[name] = v;
  }
  const steps = (s.steps ?? [])
    .map((x) => x.replace(/\{\{\s*([a-z0-9_ -]+)\s*\}\}/gi, (_, k) => values[k] ?? `{{${k}}}`))
    .map((x, i) => `${i + 1}. ${x}`)
    .join('\n');
  return `Run the "${s.name}" skill${steps ? `:\n${steps}` : '.'}`;
}

export function fireSkill(s: Skill): void {
  const t = skillToRunText(s);
  if (t) runText(t);
}
