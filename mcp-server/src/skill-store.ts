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
  /** Deterministic replay actions (recorded) — run in one call, no model. */
  actions?: unknown[];
  /** Bumped on every update; old revisions are archived under .versions/. */
  version: number;
  createdAt: number;
  updatedAt: number;
  changelog: Array<{ version: number; at: number; note?: string; source?: string }>;
}

const HOME = homedir();
const CANON = join(HOME, '.pilot', 'skills');

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'skill';
}

function frontmatterMd(s: Skill): string {
  const inputs = s.inputs.length ? `## Inputs\n${s.inputs.map((i) => `- ${i}`).join('\n')}\n\n` : '';
  const acts = (s.actions ?? []) as Array<{ why?: string; live?: boolean }>;
  const steps = `## Steps\n${s.steps
    .map((x, i) => {
      const a = acts[i] ?? {};
      const why = a.why ? ` — ${a.why}` : '';
      const live = a.live ? ' _(needs live check — re-inspect the page)_' : '';
      return `${i + 1}. ${x}${why}${live}`;
    })
    .join('\n')}\n`;
  return `---\nname: ${s.name}\ndescription: ${s.description}\nversion: ${s.version}\n---\n\n# ${s.name}\n\n${s.description} _(v${s.version})_\n\n${inputs}${steps}`;
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

  /** Create or update a skill. Updating bumps the version and archives the old copy. */
  save(input: {
    id?: string; name: string; description?: string; inputs?: string[];
    steps: string[]; actions?: unknown[]; note?: string; source?: string;
  }): { skill: Skill; exportedTo: string[] } {
    const now = Date.now();
    const existing = input.id ? this.get(input.id) : null;
    const prevVersion = existing?.version ?? 0;
    if (existing) this.archive(existing.id, prevVersion, existing);
    const version = prevVersion + 1;
    const skill: Skill = {
      id: input.id ?? `${slug(input.name)}-${now.toString(36)}`,
      name: input.name,
      description: input.description ?? existing?.description ?? '',
      inputs: input.inputs ?? existing?.inputs ?? [],
      steps: input.steps ?? existing?.steps ?? [],
      ...(input.actions ? { actions: input.actions } : existing?.actions ? { actions: existing.actions } : {}),
      version,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      changelog: [
        ...(existing?.changelog ?? []),
        { version, at: now, note: input.note ?? (existing ? 'updated' : 'created'), source: input.source },
      ],
    };
    writeFileSync(join(CANON, `${skill.id}.json`), JSON.stringify(skill, null, 2), 'utf8');
    return { skill, exportedTo: this.export(skill) };
  }

  /** Write the skill to every detected harness. */
  private export(skill: Skill): string[] {
    const exportedTo: string[] = [];
    for (const c of detectClients()) {
      try { c.write(skill); exportedTo.push(c.label); } catch { /* skip */ }
    }
    return exportedTo;
  }

  /** Archive a revision under .versions/<id>/v<n>.json (best effort). */
  private archive(id: string, version: number, skill: Skill): void {
    try {
      const dir = join(CANON, '.versions', id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `v${version || 1}.json`), JSON.stringify(skill, null, 2), 'utf8');
    } catch { /* skip */ }
  }

  list(): Skill[] {
    if (!existsSync(CANON)) return [];
    const out: Skill[] = [];
    for (const f of readdirSync(CANON)) {
      if (!f.endsWith('.json')) continue;
      try {
        const s = JSON.parse(readFileSync(join(CANON, f), 'utf8')) as Skill;
        s.version ??= 1;
        s.changelog ??= [];
        out.push(s);
      } catch { /* skip */ }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): Skill | null {
    const f = join(CANON, `${id}.json`);
    if (!existsSync(f)) return null;
    try {
      const s = JSON.parse(readFileSync(f, 'utf8')) as Skill;
      s.version ??= 1;
      s.changelog ??= [];
      return s;
    } catch { return null; }
  }

  /** Find a skill by exact name or id (case-insensitive name). */
  find(nameOrId: string): Skill | null {
    return this.get(nameOrId)
      ?? this.list().find((s) => s.name === nameOrId)
      ?? this.list().find((s) => s.name.toLowerCase() === nameOrId.toLowerCase())
      ?? null;
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

  /** Rename a skill in place (bumps version) and re-export it. */
  rename(id: string, name: string): { skill: Skill; exportedTo: string[] } | null {
    const s = this.get(id);
    if (!s || !name.trim()) return null;
    return this.save({
      id, name: name.trim(), description: s.description, inputs: s.inputs,
      steps: s.steps, actions: s.actions, note: 'renamed',
    });
  }
}
