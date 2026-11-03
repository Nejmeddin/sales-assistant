import { pino } from "pino";

const isDev = process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info"),
  redact: {
    paths: ["*.accessToken", "*.apiKey", "*.password", "*.pass", "*.appSecret", "access_token"],
    censor: "[redacted]",
  },
  ...(isDev ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } } : {}),
});

export type Logger = typeof logger;
