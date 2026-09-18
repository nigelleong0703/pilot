/**
 * Skill store + auto-export.
 *
 * Recorded/authored skills are saved canonically under ~/.pilot/skills, then
 * AUTO-EXPORTED into the native skill format of every AI agent detected on this
 * machine (Claude Code, Codex, pi …) so a skill you teach once shows up
 * everywhere. Detection is by the presence of each agent's config dir.
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
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
    // Codex discovers skills as ~/.codex/skills/<name>/SKILL.md (name +
    // description frontmatter), NOT ~/.codex/prompts/*.md (custom slash
    // commands). Writing to prompts/ is why Codex couldn't find saved skills.
    out.push({ id: 'codex', label: 'Codex', write: (s) => {
      const dir = join(HOME, '.codex', 'skills', slug(s.name)); mkdirSync(dir, { recursive: true });
      const f = join(dir, 'SKILL.md'); writeFileSync(f, frontmatterMd(s), 'utf8'); return f;
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

  /** Remove a skill and its exported copies (best effort). */
  delete(id: string): boolean {
    const skill = this.get(id);
    const f = join(CANON, `${id}.json`);
    if (existsSync(f)) rmSync(f, { force: true });
    if (!skill) return false;
    for (const c of detectClients()) {
      try {
        const slugName = slug(skill.name);
        if (c.id === 'codex') rmSync(join(HOME, '.codex', 'skills', slugName), { recursive: true, force: true });
        else rmSync(join(HOME, c.id === 'claude' ? '.claude' : '.pi', 'skills', slugName), { recursive: true, force: true });
      } catch { /* skip */ }
    }
    return true;
  }

  /** Rename a skill in place and re-export it. */
  rename(id: string, name: string): { skill: Skill; exportedTo: string[] } | null {
    const s = this.get(id);
    if (!s || !name.trim()) return null;
    const skill: Skill = { ...s, name: name.trim() };
    writeFileSync(join(CANON, `${id}.json`), JSON.stringify(skill, null, 2), 'utf8');
    const exportedTo: string[] = [];
    for (const c of detectClients()) {
      try { c.write(skill); exportedTo.push(c.label); } catch { /* skip */ }
    }
    return { skill, exportedTo };
  }
}
