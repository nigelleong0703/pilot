import { DropdownMenu } from 'radix-ui';
import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import { useState } from 'react';
import { useSettings } from '@/entrypoints/sidepanel/settings-store';
import { AGENT_CAPS, CLAUDE_MODELS } from '@/entrypoints/sidepanel/settings';
import { resetSession } from '@/entrypoints/sidepanel/adapter';
import { cn } from '@/lib/utils';

const EFFORTS = [
  { id: 'low', label: 'Low', description: 'Minimal thinking, fastest' },
  { id: 'medium', label: 'Medium', description: 'Moderate thinking' },
  { id: 'high', label: 'High', description: 'Deep reasoning' },
] as const;

type EffortId = (typeof EFFORTS)[number]['id'];

const item = 'flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground';

/**
 * Composer-bar "model · effort" control, driven by the AGENT_CAPS
 * normalization layer. Claude gets preset aliases; BYO agents that accept
 * --model (opencode/qwen) get a free-form box; agents that pick their model
 * internally (Pi, Gemini, Kimi, Grok, Codex) get nothing. Effort is Claude-only.
 */
export function ModelEffortSelector() {
  const { settings, update } = useSettings();
  const [draft, setDraft] = useState('');

  const caps = AGENT_CAPS[settings.agentId];
  const isClaude = settings.agentId === 'claude';
  const showModel = caps.modelControl !== 'none' && (isClaude || settings.byoEnabled);

  const modelLabel = isClaude
    ? CLAUDE_MODELS.find((m) => m.id === settings.model)?.label ?? 'Default'
    : settings.byoModel
      ? settings.byoModel
      : null;
  const effortLabel = EFFORTS.find((e) => e.id === settings.effort)?.label ?? 'Medium';

  const changeModel = (model: string) => {
    void update({ model });
    resetSession();
  };

  const commitByoModel = (v: string) => {
    const m = v.trim();
    void update({ byoModel: m });
    setDraft('');
    resetSession();
  };

  const changeEffort = (effort: EffortId) => {
    void update({ effort });
    resetSession();
  };

  // Nothing composer-controllable for this agent → hide the pill entirely
  // (e.g. Pi/Grok/Gemini/Codex pick their model from their own config).
  if (!showModel && !caps.effort) return null;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="flex h-7 items-center gap-1 rounded-full px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Model and reasoning effort"
        >
          {modelLabel && (
            <span className="font-medium">
              {modelLabel}
              <span className="mx-1 opacity-60">·</span>
            </span>
          )}
          {caps.effort && effortLabel}
          <ChevronDownIcon className="size-3 opacity-60" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          side="top"
          sideOffset={6}
          className="z-50 min-w-44 rounded-md border bg-card p-1 text-card-foreground shadow-md"
        >
          {isClaude && (
            <>
              <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">Model</div>
              {CLAUDE_MODELS.map((m) => (
                <DropdownMenu.Item key={m.id} className={item} onSelect={() => changeModel(m.id)}>
                  <span className="flex-1">{m.label}</span>
                  {settings.model === m.id && <CheckIcon className="size-3.5" />}
                </DropdownMenu.Item>
              ))}
            </>
          )}
          {caps.modelControl === 'freeform' && settings.byoEnabled && (
            <>
              <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">Model</div>
              <div className="px-2 pb-1">
                <input
                  value={draft || settings.byoModel}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitByoModel(draft || settings.byoModel);
                  }}
                  onBlur={() => {
                    if (draft.trim()) commitByoModel(draft);
                    else setDraft('');
                  }}
                  placeholder="e.g. gpt-5.4 / llama-3.3-70b"
                  className="h-7 w-full rounded border bg-card px-2 text-xs outline-none focus:border-primary"
                />
                <button
                  type="button"
                  onClick={() => commitByoModel('')}
                  className="mt-0.5 w-full cursor-pointer rounded-sm px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  Default (agent's configured model)
                </button>
              </div>
            </>
          )}
          {caps.effort && (
            <>
              <div className={cn('px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground', (isClaude || showModel) && 'mt-1 border-t pt-1.5')}>
                Reasoning
              </div>
              {EFFORTS.map((e) => (
                <DropdownMenu.Item key={e.id} className={item} onSelect={() => changeEffort(e.id)}>
                  <span className="flex-1">{e.label}</span>
                  <span className="text-[10px] text-muted-foreground">{e.description}</span>
                  {settings.effort === e.id && <CheckIcon className="size-3.5" />}
                </DropdownMenu.Item>
              ))}
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}