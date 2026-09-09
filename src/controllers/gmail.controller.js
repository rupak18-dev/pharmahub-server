import { asyncHandler } from "../core/asyncHandler.js";
import { ok } from "../core/responses.js";
import { logger } from "../core/logger.js";
import { env } from "../config/env.js";
import * as gmailService from "../services/gmail.service.js";

export const startConnect = asyncHandler(async (req, res) => {
  const authorizationUrl = await gmailService.buildAuthorizationUrl(req.user);
  return ok(res, { authorizationUrl }, "Gmail OAuth started");
});

/**
 * Google redirects the browser here after OAuth consent. This endpoint is
 * intentionally public (no PharmaHub bearer token in the request) and always
 * redirects back to the frontend — success or failure. Tenant identity comes
 * from the signed `state` value, never from client-controlled query params.
 */
export const callback = asyncHandler(async (req, res) => {
  const { code, state, error } = req.query;
  const destination = (path) => `${env.frontendUrl}/integrations${path}`;
  if (error) {
    logger.warn(`[gmail] OAuth callback denied: ${error}`);
    return res.redirect(
      destination(`?gmail=error&reason=${encodeURIComponent(`Authorization denied (${error})`)}`),
    );
  }
  try {
    await gmailService.connectGmail({ code, state });
    return res.redirect(destination("?gmail=connected"));
  } catch (err) {
    logger.error("[gmail] OAuth callback failed", err);
    return res.redirect(
      destination(`?gmail=error&reason=${encodeURIComponent(err?.message ?? "Connection failed")}`),
    );
  }
});

export const sendTest = asyncHandler(async (req, res) => {
  const data = await gmailService.sendTestEmail(req.user);
  return ok(res, data, "Test email sent successfully");
});

export const disconnect = asyncHandler(async (req, res) => {
  const data = await gmailService.disconnectGmail(req.user);
  return ok(res, gmailService.toSafeIntegration(data), "Gmail disconnected");
});
