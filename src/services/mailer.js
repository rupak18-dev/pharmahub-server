import net from "node:net";

import nodemailer from "nodemailer";
import { Resend } from "resend";

import { env, isEmailConfigured, isResendConfigured } from "../config/env.js";
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
  if (!isResendConfigured()) return null;
  if (!resendClient) {
    resendClient = new Resend(env.email.apiKey);
  }
  return resendClient;
}

function getTransporter() {
  // Resend is the preferred path when configured; SMTP is unused alongside it.
  if (isResendConfigured()) {
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

/**
 * Flattens whatever the Resend SDK hands back (an `Error`-like object in most
 * versions, a thrown exception in others) into one log-safe line. The status
 * code is what separates "bad key" from "unverified sender" — without it both
 * surface as an opaque 400 and look identical in the logs.
 */
function describeResendError(error) {
  if (!error) return "unknown error";
  const parts = [error.message ?? String(error)];
  if (error.name) parts.push(`name=${error.name}`);
  const status = error.statusCode ?? error.status;
  if (status) parts.push(`status=${status}`);
  return parts.join(" ");
}

/** Maps a Resend failure to the one action that actually fixes it. */
function resendErrorHint(error) {
  const status = error?.statusCode ?? error?.status;
  const message = (error?.message ?? "").toLowerCase();

  if (status === 401 || message.includes("api key") || message.includes("unauthorized")) {
    return "The API key is invalid, revoked, or expired — re-copy it from Resend → API Keys and redeploy.";
  }
  if (status === 403 || message.includes("not verified") || message.includes("domain")) {
    return "The sender domain is not verified on this Resend account — verify its DNS records, or point EMAIL_FROM at a domain that is.";
  }
  if (status === 429) {
    return "Resend rate limit or daily quota exhausted — check the Resend dashboard for usage/limits.";
  }
  if (status === 422 || message.includes("test domain") || message.includes("onboarding@resend.dev")) {
    return "EMAIL_FROM is the Resend test sender, which only delivers to the account owner's own address — set EMAIL_FROM to a verified domain.";
  }
  if (message.includes("not found") || message.includes("invalid from")) {
    return "Resend rejected the sender — set EMAIL_FROM=\"Display Name <noreply@your-verified-domain.com>\".";
  }
  return "Check the Resend dashboard → Logs for the full request and response.";
}

// ── Resend startup verification ────────────────────────────────────────────────

/**
 * Contacts the Resend API once at boot to prove two things that cannot be
 * inferred from the env alone: that the key is accepted, and that the
 * EMAIL_FROM domain is actually verified.
 *
 * This check exists because `RESEND_API_KEY=<non-empty string>` was previously
 * treated as "email works". A revoked key, a key pasted with surrounding
 * whitespace, or the default `onboarding@resend.dev` sender all produced a
 * cheerful "[mail] Email delivery via Resend API" line at startup and then
 * silently skipped every email hours later, with the API still answering HTTP
 * 200. Returns true only when a send would actually be accepted.
 */
export async function verifyResendConfig() {
  const client = getResendClient();
  if (!client) return false;

  let data = null;
  let error = null;
  try {
    const response = await client.domains.list();
    data = response?.data ?? null;
    error = response?.error ?? null;
  } catch (err) {
    error = err;
  }

  if (error) {
    logger.error(
      `[mail] RESEND_API_KEY was REJECTED by the Resend API — email delivery is broken. ` +
        `resend said: ${describeResendError(error)} ` +
        `Hint: ${resendErrorHint(error)}`,
    );
    return false;
  }

  if (env.email.fromInvalid) {
    logger.error(
      `[mail] EMAIL_FROM ("${env.email.from}") is not a valid "Display Name <user@domain.com>" ` +
        "sender — Resend will reject every message. Fix EMAIL_FROM and redeploy.",
    );
    return false;
  }

  const verified = new Set(
    (data ?? [])
      .filter((domain) => domain?.status === "verified")
      .map((domain) => String(domain.name).toLowerCase()),
  );
  const fromDomain = env.email.fromDomain;

  if (verified.has(fromDomain)) {
    logger.info(
      `[mail] Resend key accepted; sender domain ${fromDomain} is verified — emails will be delivered`,
    );
    return true;
  }

  if (env.email.usesTestSender) {
    logger.warn(
      `[mail] EMAIL_FROM is still the Resend test sender (${env.email.from}). Resend only ` +
        "delivers from onboarding@resend.dev to the account owner's own email address — every " +
        "other recipient is rejected. Add a domain in the Resend dashboard, verify its DNS " +
        `records, then set EMAIL_FROM="PharmaHub <noreply@yourdomain.com>". ` +
        `Key itself is valid; verified domains on this account: ${[...verified].join(", ") || "none"}.`,
    );
    return false;
  }

  logger.error(
    `[mail] EMAIL_FROM domain "${fromDomain}" is NOT verified on this Resend account ` +
      `(verified here: ${[...verified].join(", ") || "none"}). The key is valid, but every send ` +
      "will be rejected by Resend. Verify the domain's DNS records in the Resend dashboard.",
  );
  return false;
}

// ── Startup validation ───────────────────────────────────────────────────────────

/**
 * Startup validation — checks env vars AND verifies the connection is actually
 * usable (Resend: the key is accepted and the sender domain is verified; SMTP:
 * the host is reachable and the credentials authenticate). Never logs the
 * password or any credential value. Returns true only when email is fully
 * operational — a false result here means real emails will be skipped.
 */
export async function validateEmailConfig() {
  // ── Resend path (HTTPS, reliable on Render) ────────────────────────────────────
  if (isResendConfigured()) {
    const usable = await verifyResendConfig();
    if (!usable && env.isProduction) {
      logger.error(
        "[mail] Resend is misconfigured — EVERY verification, password-reset and " +
          "invitation email will be silently skipped (the API still answers 200). " +
          "See the errors above.",
      );
    }
    return usable;
  }

  // A variable that exists but is empty reads as "configured" in every dashboard
  // while being falsy in code. Call this out instead of quietly using SMTP.
  if (env.email.apiKeyBlank) {
    logger.error(
      "[mail] RESEND_API_KEY is present but EMPTY — Resend is DISABLED and email falls " +
        "back to SMTP. Paste a real key (starts with 're_') into RESEND_API_KEY and redeploy.",
    );
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
      `[mail] SMTP credentials loaded — host=${env.smtp.host}:${env.smtp.port} secure=${env.smtp.secure} from=${env.smtp.fromAddress || env.smtp.user}`,
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
  if (isResendConfigured()) return true;
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
    // replyTo must be a bare address — a display-name form or a junk MAIL_FROM
    // makes Resend reject the entire message, not just the header.
    const replyTo = env.smtp.fromAddress ?? env.email.fromAddress ?? undefined;

    let data = null;
    let failure = null;
    try {
      const response = await resendClient.emails.send({
        from: env.email.from,
        ...(replyTo ? { replyTo } : {}),
        to: toList,
        subject,
        ...(text ? { text } : {}),
        ...(html ? { html } : {}),
        ...(resendAttachments?.length ? { attachments: resendAttachments } : {}),
      });
      data = response?.data ?? null;
      // v4+ returns { data, error } without throwing; older builds throw.
      failure = response?.error ?? null;
    } catch (err) {
      failure = err;
    }

    if (!failure) {
      logger.info(
        `[MAIL DEBUG] sendResult=success (resend) id=${data?.id} recipient=${recipient}`,
      );
      return { skipped: false, messageId: data?.id };
    }

    // A failed send must never 500 the caller (registration, verification,
    // invitations, tickets...). Report it loudly and hand back `skipped` so
    // callers answer with an honest "email not sent" response. The full
    // provider error is kept in the log AND returned, because "it doesn't
    // work" is otherwise impossible to diagnose from a 200 response.
    const detail = describeResendError(failure);
    logger.error(
      `[MAIL DEBUG] sendResult=failure (resend) recipient=${recipient} from=${env.email.from} ${detail}`,
    );
    logger.error(
      `Email delivery FAILED to ${recipient} via Resend — treated as skipped, not sent. ` +
        `Resend said: ${detail} Hint: ${resendErrorHint(failure)}`,
    );
    return {
      skipped: true,
      reason: "delivery_failed",
      error: detail,
      hint: resendErrorHint(failure),
    };
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
    // `fromAddress` is already split from any display name in MAIL_FROM, so
    // re-wrapping it here cannot produce `Name <Name <a@b.com>>`.
    const fromAddress =
      env.smtp.fromAddress || env.smtp.user || "no-reply@pharmahub.local";
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
    // Same policy as above — SMTP send failures are logged loudly and convert
    // to `skipped` so registration/verification/etc. never return 500 purely
    // because the email provider refused the message.
    logger.error(
      `[MAIL DEBUG] sendResult=failure recipient=${recipient} error=${err?.message ?? err}`,
    );
    logger.error(
      `Email delivery FAILED to ${recipient} via SMTP — treated as skipped, not sent. ` +
        `Check SMTP credentials and host egress (Gmail often blocks cloud hosts on port 587; ` +
        `consider RESEND_API_KEY).`,
    );
    return { skipped: true, reason: "delivery_failed", error: err?.message ?? String(err) };
  }
}

export const sendMail = sendEmail;
