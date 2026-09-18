import { useEffect, useRef, useState } from 'react';
import { DropdownMenu } from 'radix-ui';
import { PlusIcon, SparklesIcon, FileTextIcon, ImageIcon, ChevronRightIcon } from 'lucide-react';
import { cn } from '../lib/utils';

interface Skill { id: string; name: string; description?: string; steps?: string[] }
interface Command { name: string; description?: string }

/** Fire text into the current chat thread (App/Chat listens for this). */
function run(text: string) {
  window.dispatchEvent(new CustomEvent('pilot:run', { detail: text }));
}

/**
 * Composer "+" menu: pick a Skill (recorded here or native to the current agent
 * via ACP), or upload a document. Skills are fetched from the daemon on open.
 */
export function PlusMenu() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [commands, setCommands] = useState<Command[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const imgRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onMsg = (m: any) => {
      if (m?.kind === 'ACP_UPDATE' && m.payload?.type === 'acp/skills') {
        setSkills(m.payload.skills ?? []);
        setCommands(m.payload.commands ?? []);
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  const refresh = () => chrome.runtime.sendMessage({ kind: 'ACP_SEND', payload: { type: 'acp/listSkills' } }).catch(() => {});

  function fireSkill(s: Skill) {
    const steps = (s.steps ?? []).map((x, i) => `${i + 1}. ${x}`).join('\n');
    run(`Run the "${s.name}" skill${steps ? `:\n${steps}` : '.'}`);
  }
  function fireCommand(c: Command) {
    run(`/${c.name}`);
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text().catch(() => '');
    const clipped = text.length > 12000 ? text.slice(0, 12000) + '\n…(truncated)' : text;
    run(`Here is a document "${file.name}":\n\n\`\`\`\n${clipped}\n\`\`\``);
  }

  async function onImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { alert('Image too large (max 5 MB).'); return; }
    const dataUrl = await new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result as string);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
    window.dispatchEvent(new CustomEvent('pilot:runParts', {
      detail: [{ type: 'image', image: dataUrl }, { type: 'text', text: 'Here is an image — take a look at it.' }],
    }));
  }

  const item = 'flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground';

  return (
    <>
      <input ref={fileRef} type="file" hidden accept=".txt,.md,.markdown,.json,.csv,.log,.html,.xml,.yaml,.yml" onChange={onFile} />
      <input ref={imgRef} type="file" hidden accept="image/*" onChange={onImage} />
      <DropdownMenu.Root onOpenChange={(o) => o && refresh()}>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Add"
          >
            <PlusIcon className="size-4" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            side="top"
            sideOffset={6}
            className="z-50 min-w-44 rounded-md border bg-card p-1 text-card-foreground shadow-md"
          >
            <DropdownMenu.Sub>
              <DropdownMenu.SubTrigger className={cn(item, 'justify-between')}>
                <span className="flex items-center gap-2"><SparklesIcon className="size-4" /> Skills</span>
                <ChevronRightIcon className="size-3.5 opacity-60" />
              </DropdownMenu.SubTrigger>
              <DropdownMenu.Portal>
                <DropdownMenu.SubContent className="z-50 max-h-72 min-w-52 overflow-y-auto rounded-md border bg-card p-1 text-card-foreground shadow-md">
                  {skills.length === 0 && commands.length === 0 && (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">No skills yet — record one to create it.</div>
                  )}
                  {skills.map((s) => (
                    <DropdownMenu.Item key={s.id} className={item} onSelect={() => fireSkill(s)}>
                      <span className="truncate">{s.name}</span>
                    </DropdownMenu.Item>
                  ))}
                  {commands.length > 0 && (
                    <>
                      <DropdownMenu.Separator className="my-1 h-px bg-border" />
                      <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">Agent commands</div>
                      {commands.map((c) => (
                        <DropdownMenu.Item key={c.name} className={item} onSelect={() => fireCommand(c)}>
                          <span className="truncate">/{c.name}</span>
                        </DropdownMenu.Item>
                      ))}
                    </>
                  )}
                </DropdownMenu.SubContent>
              </DropdownMenu.Portal>
            </DropdownMenu.Sub>

            <DropdownMenu.Item className={item} onSelect={() => imgRef.current?.click()}>
              <ImageIcon className="size-4" /> Upload image
            </DropdownMenu.Item>
            <DropdownMenu.Item className={item} onSelect={() => fileRef.current?.click()}>
              <FileTextIcon className="size-4" /> Upload document
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </>
  );
}
