/**
 * Skill store + auto-export.
 *
 * Recorded/authored skills are saved canonically under ~/.pilot/skills, then
 * AUTO-EXPORTED into the native skill format of every AI agent detected on this
 * machine (Claude Code, Codex, pi …) so a skill you teach once shows up
 * everywhere. Detection is by the presence of each agent's config dir.
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface Skill {
  id: string;
  name: string;
  description: string;
  inputs: string[];
  steps: string[];
  createdAt: number;
}

const HOME = homedir();
const CANON = join(HOME, '.pilot', 'skills');

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'skill';
}

function frontmatterMd(s: Skill): string {
  const inputs = s.inputs.length ? `## Inputs\n${s.inputs.map((i) => `- ${i}`).join('\n')}\n\n` : '';
  const steps = `## Steps\n${s.steps.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n`;
  return `---\nname: ${s.name}\ndescription: ${s.description}\n---\n\n# ${s.name}\n\n${s.description}\n\n${inputs}${steps}`;
}
function plainMd(s: Skill): string {
  const steps = `## Steps\n${s.steps.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n`;
  return `# ${s.name}\n\n${s.description}\n\n${steps}`;
}

export interface ClientTarget { id: string; label: string; write: (s: Skill) => string; }

/** Which agents are installed on this machine (by config-dir presence). */
export function detectClients(): ClientTarget[] {
  const out: ClientTarget[] = [];
  if (existsSync(join(HOME, '.claude'))) {
    out.push({ id: 'claude', label: 'Claude Code', write: (s) => {
      const dir = join(HOME, '.claude', 'skills', slug(s.name)); mkdirSync(dir, { recursive: true });
      const f = join(dir, 'SKILL.md'); writeFileSync(f, frontmatterMd(s), 'utf8'); return f;
    } });
  }
  if (existsSync(join(HOME, '.codex'))) {
    out.push({ id: 'codex', label: 'Codex', write: (s) => {
      const dir = join(HOME, '.codex', 'prompts'); mkdirSync(dir, { recursive: true });
      const f = join(dir, `${slug(s.name)}.md`); writeFileSync(f, plainMd(s), 'utf8'); return f;
    } });
  }
  if (existsSync(join(HOME, '.pi'))) {
    out.push({ id: 'pi', label: 'Pi', write: (s) => {
      const dir = join(HOME, '.pi', 'skills', slug(s.name)); mkdirSync(dir, { recursive: true });
      const f = join(dir, 'SKILL.md'); writeFileSync(f, frontmatterMd(s), 'utf8'); return f;
    } });
  }
  return out;
}

export class SkillStore {
  constructor() { mkdirSync(CANON, { recursive: true }); }

  save(input: { id?: string; name: string; description?: string; inputs?: string[]; steps: string[] }): { skill: Skill; exportedTo: string[] } {
    const skill: Skill = {
      id: input.id ?? `${slug(input.name)}-${Date.now().toString(36)}`,
      name: input.name,
      description: input.description ?? '',
      inputs: input.inputs ?? [],
      steps: input.steps ?? [],
      createdAt: Date.now(),
    };
    writeFileSync(join(CANON, `${skill.id}.json`), JSON.stringify(skill, null, 2), 'utf8');
    const exportedTo: string[] = [];
    for (const c of detectClients()) {
      try { c.write(skill); exportedTo.push(c.label); } catch { /* skip */ }
    }
    return { skill, exportedTo };
  }

  list(): Skill[] {
    if (!existsSync(CANON)) return [];
    const out: Skill[] = [];
    for (const f of readdirSync(CANON)) {
      if (!f.endsWith('.json')) continue;
      try { out.push(JSON.parse(readFileSync(join(CANON, f), 'utf8')) as Skill); } catch { /* skip */ }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): Skill | null {
    const f = join(CANON, `${id}.json`);
    if (!existsSync(f)) return null;
    try { return JSON.parse(readFileSync(f, 'utf8')) as Skill; } catch { return null; }
  }
}
