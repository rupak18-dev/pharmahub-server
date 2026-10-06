import { asyncHandler } from "../core/asyncHandler.js";
import { ok } from "../core/responses.js";
import * as integrationService from "../services/integration.service.js";
import * as baileysService from "../services/baileys.service.js";

export const listIntegrations = asyncHandler(async (req, res) => {
  const data = await integrationService.listIntegrations(req.user);
  return ok(res, data, "Integrations");
});

export const getIntegration = asyncHandler(async (req, res) => {
  const data = await integrationService.getIntegration(req.user, req.params.id);
  return ok(res, data, "Integration");
});

export const connectIntegration = asyncHandler(async (req, res) => {
  const data = await integrationService.connectIntegration(req.user, req.params.id, req.body);
  const message =
    data.status === "connected" ? "Integration connected" : "Integration configuration saved";
  return ok(res, data, message);
});

export const configureIntegration = asyncHandler(async (req, res) => {
  const data = await integrationService.configureIntegration(req.user, req.params.id, req.body);
  return ok(res, data, "Integration configuration saved");
});

export const disconnectIntegration = asyncHandler(async (req, res) => {
  const tenantId = integrationService.resolveTenant(req.user);
  if (req.params.id === "whatsapp") {
    await baileysService.logoutWhatsAppSession(tenantId).catch(() => {});
  }
  const data = await integrationService.disconnectIntegration(req.user, req.params.id);
  return ok(res, data, "Integration disconnected");
});

export const getWhatsAppSession = asyncHandler(async (req, res) => {
  const tenantId = integrationService.resolveTenant(req.user);
  const data = baileysService.getSessionStatus(tenantId);
  return ok(res, data, "WhatsApp session status");
});

export const startWhatsAppSession = asyncHandler(async (req, res) => {
  const tenantId = integrationService.resolveTenant(req.user);
  const forceNew = Boolean(req.body?.forceNew);
  const data = await baileysService.initWhatsAppSession(tenantId, { forceNew });
  return ok(res, data, "WhatsApp session started");
});

export const logoutWhatsAppSession = asyncHandler(async (req, res) => {
  const tenantId = integrationService.resolveTenant(req.user);
  const data = await baileysService.logoutWhatsAppSession(tenantId);
  return ok(res, data, "WhatsApp session logged out");
});
