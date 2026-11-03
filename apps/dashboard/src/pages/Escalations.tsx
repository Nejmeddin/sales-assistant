import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, MessageCircleQuestion, Send } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { ChannelBadge } from "../components/ChannelBadge";
import { MessageThread } from "../components/MessageThread";
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Loading, PageHeader, Switch, Tabs, Textarea, cn } from "../components/ui";
import { api, type EscalationDetail, type EscalationRow } from "../lib/api";
import { formatDate, formatRelative } from "../lib/format";

type Status = "open" | "answered" | "dismissed";
const HOUR = 3_600_000;

function AnswerPanel({ id }: { id: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data } = useQuery({ queryKey: ["escalation", id], queryFn: () => api.get<EscalationDetail>(`/escalations/${id}`) });
  const [answer, setAnswer] = useState("");
  const [saveKnowledge, setSaveKnowledge] = useState(true);
  const [knowledgeQuestion, setKnowledgeQuestion] = useState("");
  const [productSpecific, setProductSpecific] = useState(true);

  useEffect(() => {
    if (data) setKnowledgeQuestion(data.escalation.question);
  }, [data]);

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["escalations"] }), qc.invalidateQueries({ queryKey: ["escalation", id] }), qc.invalidateQueries({ queryKey: ["stats"] })]);
  const send = useMutation({
    mutationFn: () => api.post(`/escalations/${id}/answer`, { answer, saveAsKnowledge: saveKnowledge, knowledgeQuestion, productSpecific }),
    onSuccess: async () => {
      toast.success(t("escalations.sent"));
      setAnswer("");
      await refresh();
    },
  });
  const dismiss = useMutation({
    mutationFn: () => api.post(`/escalations/${id}/dismiss`),
    onSuccess: async () => {
      await refresh();
      navigate("/escalations");
    },
  });

  if (!data) return <Loading />;
  const { escalation, contact, product, messages, conversation } = data;
  const age = Date.now() - new Date(conversation.lastInboundAt ?? escalation.createdAt).getTime();

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              {contact.displayName ?? t("inbox.unknownClient")} <ChannelBadge channel={contact.channel} />
            </span>
          }
          description={formatDate(escalation.createdAt)}
          action={
            <Link to={`/conversations/${conversation.id}`} className="text-xs text-brand-600 hover:underline">
              {t("inbox.title")} →
            </Link>
          }
        />
        <dl className="grid gap-4 p-5 text-sm sm:grid-cols-3">
          <div className="sm:col-span-3">
            <dt className="text-xs text-zinc-500">{t("escalations.question")}</dt>
            <dd className="mt-1 text-base font-medium">{escalation.question}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-xs text-zinc-500">{t("escalations.reason")}</dt>
            <dd className="mt-1">{escalation.reason}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">{t("escalations.product")}</dt>
            <dd className="mt-1">{product?.name ?? t("escalations.noProduct")}</dd>
          </div>
        </dl>
      </Card>

      {escalation.status === "open" ? (
        <Card className="p-5">
          <div className="space-y-4">
            {age > 7 * 24 * HOUR ? (
              <p className="flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
                <AlertTriangle className="size-4" /> {t("escalations.window7")}
              </p>
            ) : (
              age > 24 * HOUR && (
                <p className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
                  <AlertTriangle className="size-4" /> {t("escalations.window24")}
                </p>
              )
            )}
            <Field label={t("escalations.answer")}>
              <Textarea rows={4} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={t("escalations.answerPlaceholder")} autoFocus />
            </Field>
            <Switch checked={saveKnowledge} onChange={setSaveKnowledge} label={t("escalations.saveKnowledge")} />
            {saveKnowledge && (
              <div className="space-y-3 border-l-2 border-brand-100 pl-4 dark:border-brand-700/40">
                <Field label={t("escalations.knowledgeQuestion")}>
                  <Input value={knowledgeQuestion} onChange={(e) => setKnowledgeQuestion(e.target.value)} />
                </Field>
                {product && <Switch checked={productSpecific} onChange={setProductSpecific} label={t("escalations.productSpecific")} description={product.name} />}
              </div>
            )}
            <div className="flex justify-between gap-2">
              <Button variant="ghost" onClick={() => dismiss.mutate()} loading={dismiss.isPending}>
                {t("escalations.dismiss")}
              </Button>
              <Button onClick={() => send.mutate()} disabled={!answer.trim() || age > 7 * 24 * HOUR} loading={send.isPending}>
                <Send className="size-4" /> {t("escalations.send")}
              </Button>
            </div>
          </div>
        </Card>
      ) : (
        escalation.answer && (
          <Card className="p-5">
            <div className="flex items-center gap-2 text-sm text-emerald-600">
              <CheckCircle2 className="size-4" /> {t("escalations.answeredOn", { date: formatDate(escalation.answeredAt) })}
            </div>
            <p className="mt-2 text-sm whitespace-pre-wrap">{escalation.answer}</p>
          </Card>
        )
      )}

      <Card>
        <CardHeader title={t("escalations.conversation")} />
        <MessageThread messages={messages} className="max-h-[420px] overflow-y-auto p-5" />
      </Card>
    </div>
  );
}

export default function Escalations() {
  const { t } = useTranslation();
  const { id } = useParams();
  const [status, setStatus] = useState<Status>("open");
  const { data, isLoading } = useQuery({
    queryKey: ["escalations", status],
    queryFn: () => api.get<{ escalations: EscalationRow[] }>(`/escalations?status=${status}`).then((r) => r.escalations),
    refetchInterval: 15_000,
  });

  return (
    <>
      <PageHeader
        title={t("escalations.title")}
        description={t("escalations.subtitle")}
        actions={
          <Tabs
            value={status}
            onChange={setStatus}
            items={[
              { value: "open", label: t("escalations.open") },
              { value: "answered", label: t("escalations.answered") },
              { value: "dismissed", label: t("escalations.dismissed") },
            ]}
          />
        }
      />
      <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
        <Card className={cn("self-start overflow-hidden", id && "hidden lg:block")}>
          {isLoading && <Loading />}
          {data?.length === 0 && <EmptyState icon={<MessageCircleQuestion className="size-5" />}>{t("common.empty")}</EmptyState>}
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {data?.map(({ escalation, contact, productName }) => (
              <li key={escalation.id}>
                <Link to={`/escalations/${escalation.id}`} className={cn("block px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/50", id === escalation.id && "bg-brand-50/60 dark:bg-brand-700/10")}>
                  <div className="text-sm font-medium">{escalation.question}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
                    <span>{contact.displayName ?? t("inbox.unknownClient")}</span>·<span>{formatRelative(escalation.createdAt)}</span>
                    {productName && <Badge>{productName}</Badge>}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
        <div className={cn(!id && "hidden lg:block")}>
          {id ? (
            <>
              <Link to="/escalations" className="mb-3 inline-block text-sm text-zinc-500 lg:hidden">
                ← {t("common.back")}
              </Link>
              <AnswerPanel key={id} id={id} />
            </>
          ) : (
            <Card>
              <EmptyState icon={<MessageCircleQuestion className="size-5" />}>{t("escalations.subtitle")}</EmptyState>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
