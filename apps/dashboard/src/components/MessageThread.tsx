import { Paperclip } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { Message } from "../lib/api";
import { formatDate } from "../lib/format";
import { cn } from "./ui";

export function MessageThread({ messages, className }: { messages: Message[]; className?: string }) {
  const { t } = useTranslation();
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [messages.length]);

  return (
    <div className={cn("space-y-3", className)}>
      {messages.map((m) => {
        const mine = m.direction === "out";
        return (
          <div key={m.id} className={cn("flex", mine ? "justify-end" : "justify-start")}>
            <div className="max-w-[80%]">
              <div
                className={cn(
                  "rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap",
                  !mine && "rounded-bl-md bg-zinc-100 dark:bg-zinc-800",
                  mine && m.author === "bot" && "rounded-br-md bg-brand-600 text-white",
                  mine && m.author === "human" && "rounded-br-md bg-emerald-600 text-white",
                )}
              >
                {m.text}
                {m.attachments.map((a, i) =>
                  a.type === "image" && a.url ? (
                    <img key={i} src={a.url} alt="" className="mt-2 max-h-48 rounded-lg" loading="lazy" />
                  ) : (
                    <a key={i} href={a.url} target="_blank" rel="noreferrer" className="mt-1 flex items-center gap-1 text-xs underline opacity-80">
                      <Paperclip className="size-3" /> {a.title ?? a.type}
                    </a>
                  ),
                )}
              </div>
              <div className={cn("mt-1 px-1 text-[11px] text-zinc-400", mine && "text-right")}>
                {t(`inbox.author_${m.author}`)} · {formatDate(m.createdAt, { dateStyle: "short", timeStyle: "short" })}
              </div>
            </div>
          </div>
        );
      })}
      <div ref={end} />
    </div>
  );
}
