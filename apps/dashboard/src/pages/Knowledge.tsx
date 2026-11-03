import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Pencil, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge, Button, Card, Drawer, EmptyState, Field, Input, Loading, PageHeader, Select, Switch, Textarea } from "../components/ui";
import { api, type KnowledgeEntry, type Product } from "../lib/api";
import { formatDate } from "../lib/format";

type Draft = { id?: string; question: string; answer: string; productId: string | null; enabled: boolean };

function Editor({ draft, products, onClose }: { draft: Draft; products: Product[]; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [d, setD] = useState(draft);
  const save = useMutation({
    mutationFn: () => {
      const body = { question: d.question, answer: d.answer, productId: d.productId, enabled: d.enabled };
      return d.id ? api.patch(`/knowledge/${d.id}`, body) : api.post("/knowledge", body);
    },
    onSuccess: async () => {
      toast.success(t("common.saved"));
      await qc.invalidateQueries({ queryKey: ["knowledge"] });
      onClose();
    },
  });
  return (
    <Drawer
      open
      onClose={onClose}
      title={d.id ? t("common.edit") : t("knowledge.new")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={d.question.trim().length < 3 || !d.answer.trim()}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t("knowledge.question")}>
          <Input value={d.question} onChange={(e) => setD({ ...d, question: e.target.value })} autoFocus />
        </Field>
        <Field label={t("knowledge.answer")}>
          <Textarea rows={6} value={d.answer} onChange={(e) => setD({ ...d, answer: e.target.value })} />
        </Field>
        <Field label={t("knowledge.product")}>
          <Select value={d.productId ?? ""} onChange={(e) => setD({ ...d, productId: e.target.value || null })}>
            <option value="">{t("knowledge.general")}</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Switch checked={d.enabled} onChange={(enabled) => setD({ ...d, enabled })} label={t("knowledge.enabled")} />
      </div>
    </Drawer>
  );
}

export default function Knowledge() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Draft | null>(null);
  const [q, setQ] = useState("");
  const { data, isLoading } = useQuery({ queryKey: ["knowledge"], queryFn: () => api.get<{ knowledge: KnowledgeEntry[] }>("/knowledge").then((r) => r.knowledge) });
  const products = useQuery({ queryKey: ["products"], queryFn: () => api.get<{ products: Product[] }>("/products").then((r) => r.products) });
  const productName = useMemo(() => new Map(products.data?.map((p) => [p.id, p.name])), [products.data]);
  const toggle = useMutation({
    mutationFn: (e: KnowledgeEntry) => api.patch(`/knowledge/${e.id}`, { enabled: !e.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["knowledge"] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/knowledge/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["knowledge"] }),
  });
  const filtered = data?.filter((e) => !q || `${e.question} ${e.answer}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <>
      <PageHeader
        title={t("knowledge.title")}
        description={t("knowledge.subtitle")}
        actions={
          <Button onClick={() => setEditing({ question: "", answer: "", productId: null, enabled: true })}>
            <Plus className="size-4" /> {t("knowledge.new")}
          </Button>
        }
      />
      <Card>
        <div className="border-b border-zinc-100 p-3 dark:border-zinc-800">
          <Input className="max-w-xs" placeholder={t("common.search")} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {isLoading && <Loading />}
        {filtered?.length === 0 && <EmptyState icon={<BookOpen className="size-5" />}>{t("common.empty")}</EmptyState>}
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {filtered?.map((e) => (
            <li key={e.id} className="flex gap-4 px-5 py-4">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{e.question}</span>
                  <Badge tone={e.source === "escalation" ? "brand" : "neutral"}>{t(`knowledge.source_${e.source}`)}</Badge>
                  <Badge>{e.productId ? (productName.get(e.productId) ?? "—") : t("knowledge.general")}</Badge>
                </div>
                <p className="mt-1 text-sm whitespace-pre-wrap text-zinc-600 dark:text-zinc-300">{e.answer}</p>
                <p className="mt-1 text-xs text-zinc-400">{formatDate(e.createdAt, { dateStyle: "medium" })}</p>
              </div>
              <div className="flex shrink-0 items-start gap-1">
                <Switch checked={e.enabled} onChange={() => toggle.mutate(e)} />
                <Button variant="ghost" size="sm" onClick={() => setEditing({ ...e })} aria-label={t("common.edit")}>
                  <Pencil className="size-3.5" />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => confirm(t("common.confirmDelete")) && remove.mutate(e.id)} aria-label={t("common.delete")}>
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Card>
      {editing && <Editor draft={editing} products={products.data ?? []} onClose={() => setEditing(null)} />}
    </>
  );
}
