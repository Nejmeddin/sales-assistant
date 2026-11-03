import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, type ReactNode } from "react";
import { api, type User } from "./api";

type AuthState = { user: User | null; loading: boolean; refresh: () => Promise<void> };
const AuthContext = createContext<AuthState>({ user: null, loading: true, refresh: async () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["me"],
    queryFn: () => api.get<{ user: User }>("/auth/me").then((r) => r.user).catch(() => null),
    staleTime: Infinity,
  });

  useEffect(() => {
    const onExpired = () => qc.setQueryData(["me"], null);
    window.addEventListener("auth:expired", onExpired);
    return () => window.removeEventListener("auth:expired", onExpired);
  }, [qc]);

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["me"] });
  };
  return <AuthContext.Provider value={{ user: data ?? null, loading: isLoading, refresh }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
