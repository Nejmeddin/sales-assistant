import { eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { SignJWT, jwtVerify } from "jose";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import { hashPassword, verifyPassword } from "../lib/crypto.js";

const COOKIE = "sa_session";
const TTL_SECONDS = 7 * 24 * 3600;

export type SessionUser = { id: string; email: string; role: "admin" | "agent" };
export type AuthVariables = { user: SessionUser };

export class Auth {
  private readonly key: Uint8Array;
  constructor(
    private readonly db: Db,
    secret: string,
    private readonly secureCookies: boolean,
  ) {
    this.key = new TextEncoder().encode(secret);
  }

  async ensureAdmin(email?: string, password?: string): Promise<void> {
    if (!email || !password) return;
    const existing = await this.db.query.users.findFirst();
    if (existing) return;
    await this.db.insert(users).values({ email: email.toLowerCase(), passwordHash: await hashPassword(password), role: "admin" });
  }

  async login(c: Context, email: string, password: string): Promise<SessionUser | undefined> {
    const user = await this.db.query.users.findFirst({ where: eq(users.email, email.toLowerCase()) });
    if (!user || !(await verifyPassword(password, user.passwordHash))) return undefined;
    const session: SessionUser = { id: user.id, email: user.email, role: user.role };
    const token = await new SignJWT({ ...session })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(`${TTL_SECONDS}s`)
      .sign(this.key);
    setCookie(c, COOKIE, token, { httpOnly: true, sameSite: "Lax", secure: this.secureCookies, path: "/", maxAge: TTL_SECONDS });
    return session;
  }

  logout(c: Context): void {
    deleteCookie(c, COOKIE, { path: "/" });
  }

  middleware(): MiddlewareHandler<{ Variables: AuthVariables }> {
    return async (c, next) => {
      const token = getCookie(c, COOKIE);
      if (!token) return c.json({ error: "unauthorized" }, 401);
      try {
        const { payload } = await jwtVerify(token, this.key);
        c.set("user", { id: String(payload.id), email: String(payload.email), role: payload.role === "agent" ? "agent" : "admin" });
      } catch {
        return c.json({ error: "unauthorized" }, 401);
      }
      await next();
    };
  }
}
