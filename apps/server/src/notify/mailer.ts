import nodemailer from "nodemailer";
import type { Settings } from "../settings/schema.js";

export type Email = { to: string[]; subject: string; html: string; text: string; replyTo?: string };

export interface Mailer {
  send(email: Email): Promise<void>;
}

class SmtpMailer implements Mailer {
  private readonly transport;
  constructor(private readonly cfg: Settings["notifications"]["smtp"]) {
    this.transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
    });
  }
  async send(email: Email): Promise<void> {
    await this.transport.sendMail({ from: this.cfg.from || this.cfg.user, ...email });
  }
}

class ResendMailer implements Mailer {
  constructor(private readonly cfg: Settings["notifications"]["resend"]) {}
  async send(email: Email): Promise<void> {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.cfg.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: this.cfg.from, to: email.to, subject: email.subject, html: email.html, text: email.text, reply_to: email.replyTo }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  }
}

export type MailerFactory = (cfg: Settings["notifications"]) => Mailer | undefined;

export const createMailer: MailerFactory = (cfg) => {
  if (cfg.transport === "smtp" && cfg.smtp.user && cfg.smtp.pass) return new SmtpMailer(cfg.smtp);
  if (cfg.transport === "resend" && cfg.resend.apiKey && cfg.resend.from) return new ResendMailer(cfg.resend);
  return undefined;
};

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** E-mail sent to the team when the bot cannot answer. */
export function escalationEmail(p: {
  businessName: string;
  clientName: string;
  channel: string;
  question: string;
  reason: string;
  productName?: string;
  transcript: { author: string; text: string }[];
  answerUrl: string;
}): Omit<Email, "to"> {
  const lines = p.transcript.map((m) => `${m.author}: ${m.text}`).join("\n");
  const text = `Question client (${p.channel}) — ${p.clientName}
Produit: ${p.productName ?? "non identifié"}
Question: ${p.question}
Raison: ${p.reason}

Conversation récente:
${lines}

Répondre: ${p.answerUrl}`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:640px">
  <h2 style="margin:0 0 8px">❓ Question client à traiter</h2>
  <p style="color:#555;margin:0 0 16px">${escapeHtml(p.businessName)} · ${escapeHtml(p.channel)} · ${escapeHtml(p.clientName)}</p>
  <table style="border-collapse:collapse;width:100%;margin-bottom:16px">
    <tr><td style="padding:6px 0;color:#777;width:110px">Produit</td><td>${escapeHtml(p.productName ?? "non identifié")}</td></tr>
    <tr><td style="padding:6px 0;color:#777">Question</td><td><strong>${escapeHtml(p.question)}</strong></td></tr>
    <tr><td style="padding:6px 0;color:#777">Raison</td><td>${escapeHtml(p.reason)}</td></tr>
  </table>
  <pre style="background:#f6f6f6;padding:12px;border-radius:8px;white-space:pre-wrap;font-size:13px">${escapeHtml(lines)}</pre>
  <p><a href="${p.answerUrl}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Répondre au client</a></p>
  <p style="color:#888;font-size:12px">Votre réponse sera envoyée au client et enregistrée pour que l'assistant apprenne.</p>
</div>`;
  return { subject: `[${p.businessName}] Question client: ${p.question.slice(0, 60)}`, html, text };
}
