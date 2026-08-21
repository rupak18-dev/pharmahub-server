/**
 * email.service.js — thin wrapper that delegates to the canonical mailer.js.
 *
 * This file previously referenced flat env.smtpHost / env.smtpUser properties
 * that do not exist (env uses the nested env.smtp.host / env.smtp.user paths).
 * All email delivery goes through mailer.js which uses the correct structure.
 * The sendMail export is kept for backward-compatibility with any existing
 * callers that import from this file.
 */
export { sendEmail as sendMail, sendEmail } from "./mailer.js";
