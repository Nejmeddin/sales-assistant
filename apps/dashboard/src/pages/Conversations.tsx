import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Inbox, Pause, Play } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import { ChannelBadge } from "../components/ChannelBadge";
import { MessageThread } from "../components/MessageThread";
import { Badge, Button, Card, EmptyState, Loading, PageHeader, Tabs, cn, type Tone } from "../components/ui";
import { api, type ConversationDetail, type ConversationRow } from "../lib/api";
import { formatDate, formatRelative } from "../lib/format";

type Filter = "all" | "active" | "escalated" | "closed";
const stageTone: Record<string, Tone> = { answering: "neutral", collecting_order: "amber", ordered: "green" };

function Detail({ id }: { id: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["conversation", id], queryFn: () => api.get<ConversationDetail>(`/conversations/${id}`), refetchInterval: 10_000 });
  const pause = useMutation({
    mutationFn: (minutes: number) => api.post(`/conversations/${id}/pause`, { minutes }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["conversation", id] }),
  });
  if (!data) return <Loading />;
  const { conversation, contact, messages, orders, escalations } = data;
  const paused = conversation.botPausedUntil && new Date(conversation.botPausedUntil) > new Date();

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-zinc-100 px-5 py-3 dark:border-zinc-800">
        <Link to="/conversations" className="rounded p-1 text-zinc-500 lg:hidden">
          <ArrowLeft className="size-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold">{contact.displayName ?? t("inbox.unknownClient")}</span>
            <ChannelBadge channel={contact.channel} />
            <Badge tone={stageTone[conversation.stage]}>{t(`inbox.stage_${conversation.stage}`)}</Badge>
          </div>
          {paused && <div className="mt-0.5 text-xs text-amber-600">{t("inbox.pausedUntil", { date: formatDate(conversation.botPausedUntil) })}</div>}
        </div>
        {paused ? (
          <Button variant="secondary" size="sm" onClick={() => pause.mutate(0)} loading={pause.isPending}>
            <Play className="size-3.5" /> {t("inbox.resume")}
          </Button>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => pause.mutate(24 * 60)} loading={pause.isPending}>
            <Pause className="size-3.5" /> {t("inbox.pause")}
          </Button>
        )}
      </div>
      <div className="grid min-h-0 flex-1 xl:grid-cols-[1fr_280px]">
        <MessageThread messages={messages} className="overflow-y-auto p-5" />
        <aside className="space-y-5 border-t border-zinc-100 p-5 text-sm xl:border-t-0 xl:border-l dark:border-zinc-800">
          <section>
            <h4 className="mb-2 text-xs font-medium text-zinc-500 uppercase">{t("inbox.orders")}</h4>
            {orders.length === 0 && <p className="text-zinc-400">—</p>}
            {orders.map((o) => (
              <div key={o.id} className="mb-2 rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/50">
                <div className="flex justify-between">
                  <span className="font-medium">{o.customerName ?? "—"}</span>
                  <Badge tone={o.status === "synced" ? "green" : o.status === "sync_failed" ? "red" : o.status === "draft" ? "neutral" : "amber"}>{t(`orders.status_${o.status}`)}</Badge>
                </div>
                <div className="mt-1 text-xs text-zinc-500">
                  {[o.phone, o.city, Object.entries(o.options).map(([k, v]) => `${k}: ${v}`).join(", ")].filter(Boolean).join(" · ")}
                </div>
              </div>
            ))}
          </section>
          <section>
            <h4 className="mb-2 text-xs font-medium text-zinc-500 uppercase">{t("inbox.escalations")}</h4>
            {escalations.length === 0 && <p className="text-zinc-400">—</p>}
            {escalations.map((e) => (
              <Link key={e.id} to={`/escalations/${e.id}`} className="mb-2 block rounded-lg bg-zinc-50 p-3 hover:bg-zinc-100 dark:bg-zinc-800/50 dark:hover:bg-zinc-800">
                <div className="flex items-start justify-between gap-2">
                  <span>{e.question}</span>
                  <Badge tone={e.status === "open" ? "red" : "neutral"}>{t(`escalations.${e.status}`)}</Badge>
                </div>
              </Link>
            ))}
          </section>
        </aside>
      </div>
    </div>
  );
}

export default function Conversations() {
  const { t } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>("all");
  const { data, isLoading } = useQuery({
    queryKey: ["conversations", filter],
    queryFn: () => api.get<{ conversations: ConversationRow[] }>(`/conversations${filter === "all" ? "" : `?status=${filter}`}`).then((r) => r.conversations),
    refetchInterval: 10_000,
  });

  return (
    <>
      <PageHeader
        title={t("inbox.title")}
        actions={
          <Tabs
            value={filter}
            onChange={setFilter}
            items={[
              { value: "all", label: t("common.all") },
              { value: "active", label: t("inbox.filterActive") },
              { value: "escalated", label: t("inbox.filterEscalated") },
              { value: "closed", label: t("inbox.filterClosed") },
            ]}
          />
        }
      />
      <Card className="grid h-[calc(100dvh-11rem)] min-h-[480px] overflow-hidden lg:grid-cols-[320px_1fr]">
        <div className={cn("overflow-y-auto border-r border-zinc-100 dark:border-zinc-800", id && "hidden lg:block")}>
          {isLoading && <Loading />}
          {data?.length === 0 && <EmptyState icon={<Inbox className="size-5" />}>{t("common.empty")}</EmptyState>}
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {data?.map(({ conversation, contact, lastMessage }) => (
              <li key={conversation.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/conversations/${conversation.id}`)}
                  className={cn("w-full px-4 py-3 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/50", id === conversation.id && "bg-brand-50/60 dark:bg-brand-700/10")}
                >
                  <div className="flex items-center gap-2">
                    <span className="flex-1 truncate text-sm font-medium">{contact.displayName ?? t("inbox.unknownClient")}</span>
                    <span className="text-[11px] text-zinc-400">{formatRelative(lastMessage?.createdAt ?? conversation.createdAt)}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <span className={cn("size-1.5 shrink-0 rounded-full", contact.channel === "instagram" ? "bg-pink-500" : "bg-sky-500")} />
                    <span className="flex-1 truncate text-xs text-zinc-500">{lastMessage?.text || "…"}</span>
                    {conversation.status === "escalated" && <Badge tone="red">!</Badge>}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className={cn("min-h-0", !id && "hidden lg:block")}>{id ? <Detail id={id} /> : <EmptyState icon={<Inbox className="size-5" />}>{t("inbox.noSelection")}</EmptyState>}</div>
      </Card>
    </>
  );
}
