import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { LANGUAGES } from "../i18n";
import { Button, Card, Field, Input, cn } from "../components/ui";

export function LoginPage() {
  const { t, i18n } = useTranslation();
  const { refresh } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(undefined);
    try {
      await api.post("/auth/login", { email, password });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? t("login.invalid") : (err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="grid min-h-dvh place-items-center bg-gradient-to-br from-brand-50 via-white to-zinc-50 px-4 dark:from-zinc-950 dark:via-zinc-950 dark:to-zinc-900">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className="grid size-12 place-items-center rounded-xl bg-brand-600 text-2xl shadow-lg shadow-brand-600/25">💬</div>
          <div>
            <h1 className="text-lg font-semibold">{t("login.title")}</h1>
            <p className="text-sm text-zinc-500">{t("login.subtitle")}</p>
          </div>
        </div>
        <Card className="p-6">
          <form onSubmit={submit} className="space-y-4">
            <Field label={t("login.email")}>
              <Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label={t("login.password")}>
              <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <Button type="submit" className="w-full justify-center" loading={loading}>
              {t("login.submit")}
            </Button>
          </form>
        </Card>
        <div className="mt-4 flex justify-center gap-1">
          {LANGUAGES.map((l) => (
            <button key={l.code} type="button" onClick={() => void i18n.changeLanguage(l.code)} className={cn("rounded px-2 py-1 text-xs", i18n.resolvedLanguage === l.code ? "font-semibold" : "text-zinc-500")}>
              {l.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
