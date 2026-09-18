"use client";

import {
  useCallback,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import { useAuiState, useScrollLock } from "@assistant-ui/react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

const ANIMATION_DURATION = 200;

export type ChainOfThoughtProps = PropsWithChildren<{
  /** Indices of the parts in this chain group (used to count tool calls). */
  indices: readonly number[];
  /** True while the turn is still streaming. */
  running: boolean;
  className?: string;
}>;

/**
 * One collapsible "thinking" affordance per assistant turn, à la Claude /
 * ChatGPT / Grok: auto-opens while the agent is reasoning/tool-calling, then
 * settles into a single summary row ("Used 2 tools") that expands on demand.
 * Reasoning text and tool rows are passed in as children.
 */
function ChainOfThought({
  indices,
  running,
  className,
  children,
}: ChainOfThoughtProps) {
  const collapsibleRef = useRef<HTMLDivElement>(null);
  const lockScroll = useScrollLock(collapsibleRef, ANIMATION_DURATION);
  // Auto-open while streaming; the first manual toggle takes over permanently.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const isOpen = userOpen ?? running;

  const toolCount = useAuiState((s) =>
    indices.reduce(
      (n, i) => n + (s.message.parts[i]?.type === "tool-call" ? 1 : 0),
      0,
    ),
  );

  const label = running
    ? "Thinking"
    : toolCount > 0
      ? `Used ${toolCount} tool${toolCount === 1 ? "" : "s"}`
      : "Thought for a moment";

  const handleOpenChange = useCallback(
    (open: boolean) => {
      lockScroll();
      setUserOpen(open);
    },
    [lockScroll],
  );

  return (
    <Collapsible
      ref={collapsibleRef}
      data-slot="chain-of-thought"
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={cn("aui-chain-of-thought group/chain my-1.5 w-full", className)}
      style={
        {
          "--animation-duration": `${ANIMATION_DURATION}ms`,
        } as React.CSSProperties
      }
    >
      <CollapsibleTrigger
        data-slot="chain-of-thought-trigger"
        className="aui-chain-of-thought-trigger group/trigger text-muted-foreground hover:text-foreground flex w-fit origin-left items-center gap-2 py-1 text-sm transition-[color,scale] active:scale-[0.98]"
      >
        <BrainIcon
          data-slot="chain-of-thought-icon"
          className="aui-chain-of-thought-icon size-4 shrink-0"
        />
        <span
          data-slot="chain-of-thought-label"
          className="aui-chain-of-thought-label relative inline-block leading-none"
        >
          <span>{label}</span>
          {running ? (
            <span
              aria-hidden
              data-slot="chain-of-thought-shimmer"
              className="aui-chain-of-thought-shimmer shimmer pointer-events-none absolute inset-0 motion-reduce:animate-none"
            >
              {label}
            </span>
          ) : null}
        </span>
        <ChevronDownIcon
          data-slot="chain-of-thought-chevron"
          className={cn(
            "aui-chain-of-thought-chevron size-4 shrink-0 transition-transform duration-(--animation-duration) ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
            "-rotate-90",
            "group-data-open/trigger:rotate-0",
            "group-data-panel-open/trigger:rotate-0",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent
        data-slot="chain-of-thought-content"
        className={cn(
          "aui-chain-of-thought-content relative overflow-hidden text-sm outline-none",
          "ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none",
          "data-closed:animate-collapsible-up data-open:animate-collapsible-down",
          "data-closed:fill-mode-forwards data-closed:pointer-events-none",
          "[--tw-duration:var(--animation-duration)]",
        )}
      >
        <div
          data-slot="chain-of-thought-steps"
          className="border-border/70 mt-1 mb-2 ml-1.5 flex flex-col gap-1 border-l pl-3"
        >
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export { ChainOfThought };
