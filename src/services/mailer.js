import net from "node:net";

import nodemailer from "nodemailer";
import { Resend } from "resend";

import { env, isEmailConfigured } from "../config/env.js";
import { logger } from "../core/logger.js";

let transporterCache = null;
let resendClient = null;

// Short timeouts so failed connections surface quickly on Render instead of
// hanging for 30 s+ on a greeting handshake the remote host will never send.
const SMTP_TIMEOUTS = {
  connectionTimeout: 15_000,
  greetingTimeout: 15_000,
  socketTimeout: 60_000,
};

// ── Helpers ─────────────────────────────────────────────────────────────────────

function getResendClient() {
  if (!env.email.apiKey) return null;
  if (!resendClient) {
    resendClient = new Resend(env.email.apiKey);
  }
  return resendClient;
}

function getTransporter() {
  // Resend is the preferred path when configured; SMTP is unused alongside it.
  if (env.email.apiKey) {
    transporterCache = null;
    return null;
  }
  // Re-evaluate on every call so a runtime env change or late dotenv load is
  // always picked up. The transporter is only recreated when configuration
  // actually changes.
  const configured = isEmailConfigured();
  if (!configured) {
    transporterCache = null;
    return null;
  }
  if (!transporterCache) {
    transporterCache = nodemailer.createTransport({
      host: env.smtp.host,
      port: env.smtp.port,
      secure: env.smtp.secure,
      auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.pass } : undefined,
      ...SMTP_TIMEOUTS,
    });
  }
  return transporterCache;
}

// Quick TCP reachability check — separate "host unreachable" from TLS / auth
// failures so a timeout error in Render logs is immediately actionable.
function probeTcp(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port, timeout: timeoutMs });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("timeout", () => {
      sock.destroy();
      resolve(false);
    });
    sock.once("error", () => {
      sock.destroy();
      resolve(false);
    });
  });
}

// ── Startup validation ───────────────────────────────────────────────────────────

/**
 * Startup validation — checks env vars AND verifies the SMTP connection is
 * actually reachable. Never logs the SMTP password or any credential value.
 * Returns true only when email is fully operational.
 */
export async function validateEmailConfig() {
  // ── Resend path (HTTPS, reliable on Render) ────────────────────────────────────
  if (env.email.apiKey) {
    if (
      env.isProduction &&
      (!env.email.from || env.email.from.includes("resend.dev"))
    ) {
      logger.warn(
        "[mail] RESEND_API_KEY is set but EMAIL_FROM is missing or uses " +
          "the Resend test domain — production emails will fail. Set " +
          "EMAIL_FROM to a verified domain in the Resend dashboard.",
      );
    }
    logger.info(
      "[mail] Email delivery via Resend API (RESEND_API_KEY configured)",
    );
    return true;
  }

  // ── SMTP path ──────────────────────────────────────────────────────────────────
  const missing = [];
  if (!env.smtp.host) missing.push("SMTP_HOST");
  if (!env.smtp.port) missing.push("SMTP_PORT");
  if (!env.smtp.user) missing.push("SMTP_USER");
  if (!env.smtp.pass) missing.push("SMTP_PASSWORD");
  if (!env.smtp.from && !env.smtp.user) missing.push("MAIL_FROM");

  if (missing.length > 0) {
    const message = `Incomplete SMTP configuration — email delivery will not work. Missing: ${missing.join(", ")}`;
    if (env.isProduction) {
      logger.error(message);
    } else {
      logger.warn(`${message} (development mode — email sending will be skipped)`);
    }
    return false;
  }

  logger.info(
    `[mail] SMTP credentials loaded — host=${env.smtp.host}:${env.smtp.port} secure=${env.smtp.secure} from=${env.smtp.from || env.smtp.user}`,
  );

  // Quick reachability check — separate "host unreachable" from TLS/auth
  // failures so a timeout in Render logs is immediately actionable.
  const reachable = await probeTcp(env.smtp.host, env.smtp.port);
  if (!reachable) {
    logger.error(
      `[mail] SMTP host ${env.smtp.host}:${env.smtp.port} unreachable (TCP connection failed/refused). The host may be blocked from Render egress — consider RESEND_API_KEY instead.`,
    );
    return false;
  }
  logger.info(
    `[mail] SMTP host ${env.smtp.host}:${env.smtp.port} reachable over TCP`,
  );

  // Actually connect to the SMTP server to verify credentials are valid.
  try {
    const transporter = nodemailer.createTransport({
      host: env.smtp.host,
      port: env.smtp.port,
      secure: env.smtp.secure,
      auth: { user: env.smtp.user, pass: env.smtp.pass },
      ...SMTP_TIMEOUTS,
    });
    await transporter.verify();
    logger.info("[mail] SMTP connection verified — emails will be delivered");
    // Cache the verified transporter so sendEmail() reuses it immediately.
    transporterCache = transporter;
    return true;
  } catch (err) {
    logger.error(`[mail] SMTP connection failed — emails will NOT be delivered: ${err.message}`);
    if (env.isProduction) {
      return false;
    }
    // In development, warn but don't block startup.
    return false;
  }
}

export function isEmailEnabled() {
  if (env.email.apiKey) return true;
  return isEmailConfigured();
}

export async function sendEmail({ to, subject, text, html, attachments } = {}) {
  const recipient = Array.isArray(to) ? to.join(", ") : to;
  logger.info(`[MAIL DEBUG] sendEmail entered — recipient=${recipient} subject="${subject}"`);

  // ── Resend path (HTTPS, reliable on Render) ──────────────────────────────────
  const resendClient = getResendClient();
  if (resendClient) {
    const toList = Array.isArray(to) ? to : [to];
    // Resend expects file content as base64 for strings; Buffer is accepted as-is.
    const resendAttachments = attachments?.map((a) => ({
      filename: a.filename,
      content:
        typeof a.content === "string"
          ? Buffer.from(a.content).toString("base64")
          : a.content,
    }));
    try {
      const { data, error } = await resendClient.emails.send({
        from: env.email.from,
        replyTo: env.smtp.from || env.email.from,
        to: toList,
        subject,
        text,
        html,
        ...(resendAttachments?.length ? { attachments: resendAttachments } : {}),
      });
      if (error) throw new Error(error.message ?? "Resend API send failed");
      logger.info(
        `[MAIL DEBUG] sendResult=success (resend) id=${data?.id} recipient=${recipient}`,
      );
      return { skipped: false, messageId: data?.id };
    } catch (err) {
      logger.error(
        `[MAIL DEBUG] sendResult=failure (resend) recipient=${recipient} error=${err?.message ?? err}`,
      );
      throw err;
    }
  }

  // ── SMTP path ───────────────────────────────────────────────────────────────
  const transporter = getTransporter();
  if (!transporter) {
    // No hard throw here — even in production a misconfigured/unavailable email
    // provider must never turn registration, verification, invitations, tickets,
    // etc. into 500s. Every caller already treats `{ skipped: true }` as a
    // handled case and answers with an honest "email not sent" message.
    logger.error(
      `Email delivery is NOT configured (missing SMTP_HOST/SMTP_USER/SMTP_PASSWORD or RESEND_API_KEY) — ` +
        `message to ${recipient} was SKIPPED, not sent. The recipient will NOT receive this email.`,
    );
    logger.info(`[MAIL DEBUG] sendResult=skipped (no email provider configured) recipient=${recipient}`);
    return { skipped: true, reason: "email_unconfigured" };
  }
  try {
    const fromAddress = env.smtp.from || env.smtp.user || "no-reply@pharmahub.local";
    const fromName = env.smtp.fromName || "PharmaHub";
    const from = `${fromName} <${fromAddress}>`;
    const info = await transporter.sendMail({
      from,
      replyTo: fromAddress,
      to: recipient,
      subject,
      text,
      html,
      attachments,
    });
    logger.info(
      `[MAIL DEBUG] sendResult=success messageId=${info.messageId} recipient=${recipient}`,
    );
    return { skipped: false, messageId: info.messageId };
  } catch (err) {
    logger.error(
      `[MAIL DEBUG] sendResult=failure recipient=${recipient} error=${err?.message ?? err}`,
    );
    throw err;
  }
}

export const sendMail = sendEmail;
