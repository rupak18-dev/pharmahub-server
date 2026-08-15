import { env } from "../config/env.js";
import { ApiError } from "../core/ApiError.js";

let resend = null;

/**
 * Sends a transactional email. When RESEND_API_KEY is set the email goes out
 * through Resend; otherwise it is printed to the server console (development
 * only — production throws so a missing provider is never silent).
 *
 * @returns {"resend" | "console"} which transport was used
 */
export async function sendEmail({ to, subject, html }) {
  if (env.email.apiKey) {
    if (!resend) {
      const { Resend } = await import("resend");
      resend = new Resend(env.email.apiKey);
    }
    const { error } = await resend.emails.send({
      from: env.email.from,
      to,
      subject,
      html,
    });
    if (error) {
      throw ApiError.badRequest(`Could not send email: ${error.message}`);
    }
    return "resend";
  }

  if (env.isProduction) {
    throw ApiError.badRequest(
      "Email service is not configured. Ask the admin to add RESEND_API_KEY.",
    );
  }

  const plain = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  console.log(`[email][dev] To: ${to} | Subject: ${subject}`);
  console.log(`[email][dev] Body: ${plain}`);
  return "console";
}
