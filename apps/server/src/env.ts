import { z } from "zod";

/**
 * Bootstrap configuration only. Everything a business owner may want to change
 * (AI keys, Meta tokens, emails, Sheets…) lives in the database and is edited
 * from the dashboard — see `settings/schema.ts`.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  /** 32-byte key, base64 encoded. Encrypts secrets stored in the settings table. */
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, "ENCRYPTION_KEY must be 32 bytes base64 (openssl rand -base64 32)"),
  /** Signs dashboard session cookies. */
  SESSION_SECRET: z.string().min(32),
  /** Public HTTPS base URL (used in escalation e-mails and shown as the webhook URL). */
  PUBLIC_URL: z.string().url().default("http://localhost:3000"),
  /** First admin account, created at boot when no user exists. */
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(8).optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  /** Run the background worker in this process (disable to scale API and worker separately). */
  RUN_WORKER: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function env(): Env {
  cached ??= EnvSchema.parse(process.env);
  return cached;
}

/** Test helper: force re-reading process.env. */
export function resetEnvCache(): void {
  cached = undefined;
}
