import path from "node:path";

import { ApiError } from "../core/ApiError.js";
import { logger } from "../core/logger.js";
import { whatsAppConfig, isWhatsAppConfigured } from "../config/env.js";
import { Integration } from "../models/Integration.js";
import { ReportBill } from "../models/ReportBill.js";
import { resolveTenant } from "./integration.service.js";
import { isValidIndianPhone, normalizeIndianPhone } from "../utils/phone.js";
import { storedFilePath } from "../middlewares/upload.js";
import { generateInvoiceDocument } from "./invoicePdf.service.js";

// WhatsApp Business bill delivery. The bill is ALWAYS persisted first (by the
// caller); this service only attempts the best-effort delivery and records the
// outcome on the bill's whatsappDelivery subdocument. It never throws for Meta
// failures — the bill must survive regardless of the delivery result.

export const WHATSAPP_DELIVERY_STATUSES = ["not_attempted", "pending", "sent", "failed", "skipped"];

// Reasons a delivery attempt was skipped (reported alongside status "skipped").
// "not_connected" means the organization has NO connected WhatsApp Business
// integration; "server_not_configured" means the integration IS connected but
// the server lacks the Meta Cloud API credentials to actually send.
export const WHATSAPP_DELIVERY_SKIP_REASONS = [
  "not_connected",
  "server_not_configured",
  "no_number",
  "invalid_number",
];

export const isSalesBill = (bill) => bill?.documentType === "sales_invoice";

function resolveDeliveryPhone(bill) {
  const raw = String(bill?.customer?.phone ?? "").trim();
  if (!raw) return { ok: false, reason: "no_number" };
  if (!isValidIndianPhone(raw)) return { ok: false, reason: "invalid_number" };
  return { ok: true, phone: normalizeIndianPhone(raw) };
}

function formatMoney(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "0.00";
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function buildBillCaption(bill, orgName, currencySymbol) {
  const store = String(orgName ?? "").trim() || "PharmaHub";
  const number = bill.invoice?.invoiceNumber ?? "";
  const total = formatMoney(bill.totals?.grandTotal);
  return [
    `Thank you for your purchase from ${store}.`,
    "",
    `Your bill ${number} is ready.`,
    "",
    `Total: ${currencySymbol}${total}`,
    "",
    "Please find your invoice attached.",
  ].join("\n");
}

async function findWhatsAppIntegration(user) {
  const tenantId = resolveTenant(user);
  return Integration.findOne({ tenantId, key: "whatsapp", connected: true }).lean();
}

function documentLink(filePath, publicUrl) {
  return `${String(publicUrl).replace(/\/$/, "")}${filePath}`;
}

// Uses the actual persisted document when the bill came from an upload;
// otherwise generates a real invoice PDF from the saved bill fields.
async function prepareBillDocument(bill, publicUrl) {
  const uploaded = bill.originalDocument;
  if (uploaded?.path && storedFilePath(uploaded.path)) {
    return {
      path: uploaded.path,
      filename: uploaded.filename ?? path.basename(uploaded.path),
      mimeType: uploaded.mimeType ?? "application/octet-stream",
      link: documentLink(uploaded.path, publicUrl),
    };
  }
  return generateInvoiceDocument(bill, { publicUrl });
}

function buildMessagePayload(bill, to, document, caption, orgName) {
  const cfg = whatsAppConfig();
  if (cfg.templateName) {
    // Business-initiated conversations can require an approved template.
    return {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: cfg.templateName,
        language: { code: cfg.templateLang },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: String(orgName ?? "PharmaHub") },
              { type: "text", text: String(bill.invoice?.invoiceNumber ?? "") },
              {
                type: "text",
                text: `${cfg.currencySymbol}${formatMoney(bill.totals?.grandTotal)}`,
              },
            ],
          },
        ],
      },
    };
  }

  const isImage = String(document.mimeType ?? "").startsWith("image/");
  const media = isImage
    ? { link: document.link, caption }
    : { link: document.link, filename: document.filename, caption };
  return {
    messaging_product: "whatsapp",
    to,
    type: isImage ? "image" : "document",
    [isImage ? "image" : "document"]: media,
  };
}

async function callMetaApi(payload) {
  const cfg = whatsAppConfig();
  const url = `https://graph.facebook.com/${cfg.graphVersion}/${cfg.phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.accessToken}`,
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  logger.info(`[WhatsApp] Meta response status: ${res.status}`);
  if (!res.ok) {
    const error = data?.error ?? {};
    return {
      ok: false,
      errorCode: String(error?.code ?? `meta_http_${res.status}`),
      errorMessage: error?.message ?? `WhatsApp API error (HTTP ${res.status})`,
    };
  }
  return { ok: true, messageId: data?.messages?.[0]?.id ?? null };
}

async function persistDelivery(billId, record) {
  await ReportBill.updateOne({ _id: billId }, { $set: { whatsappDelivery: record } });
}

function deliveryTrace(user, integration, phoneCheck, bill) {
  return {
    organizationId: resolveTenant(user),
    integrationFound: Boolean(integration),
    provider: integration?.key ?? null,
    status: integration ? (integration.connected ? "connected" : "disconnected") : null,
    businessNumber: integration?.config?.phone ?? null,
    customerNumber: phoneCheck.ok
      ? phoneCheck.phone
      : String(bill?.customer?.phone ?? "").trim() || null,
  };
}

function traceLog(trace, deliveryAttempted, deliveryResult) {
  return (
    `[WhatsApp Bill Delivery] organizationId: ${trace.organizationId}, ` +
    `integrationFound: ${trace.integrationFound}, provider: ${trace.provider}, ` +
    `status: ${trace.status}, businessNumber: ${trace.businessNumber}, ` +
    `customerNumber: ${trace.customerNumber}, deliveryAttempted: ${deliveryAttempted}, ` +
    `deliveryResult: ${deliveryResult}`
  );
}

// Core delivery attempt. Returns a machine-friendly summary the controller can
// echo back; the authoritative state is persisted on the bill. Never throws for
// lookup or Meta failures — the bill must survive regardless of the outcome.
export async function deliverBillToWhatsApp({ bill, user }) {
  const summary = {
    attempted: false,
    status: "not_attempted",
    reason: null,
    skippedAt: null,
    recipientPhone: null,
    messageId: null,
    errorCode: null,
    errorMessage: null,
  };

  const phoneCheck = resolveDeliveryPhone(bill);
  const integration = await findWhatsAppIntegration(user);
  const trace = deliveryTrace(user, integration, phoneCheck, bill);

  // Record + persist a skipped outcome (not connected, server creds missing,
  // no/invalid recipient). Skipping is never an error for the bill itself.
  async function skip(reason) {
    const record = {
      status: "skipped",
      reason,
      recipientPhone: phoneCheck.ok ? phoneCheck.phone : null,
      messageId: null,
      sentAt: null,
      failedAt: null,
      errorCode: null,
      errorMessage: null,
      attempts: Number(bill.whatsappDelivery?.attempts ?? 0),
      skippedAt: new Date(),
    };
    summary.status = "skipped";
    summary.reason = reason;
    summary.skippedAt = record.skippedAt;
    summary.recipientPhone = record.recipientPhone;
    await persistDelivery(bill._id, record);
    logger.info(traceLog(trace, false, `skipped (${reason})`));
    return summary;
  }

  if (!phoneCheck.ok) {
    logger.info(`[WhatsApp] Recipient for bill ${bill._id}: ${phoneCheck.reason}`);
    return skip(phoneCheck.reason);
  }
  logger.info(`[WhatsApp] Recipient: ${phoneCheck.phone} (bill ${bill._id})`);

  if (!integration) {
    logger.info("[WhatsApp] Integration found: none connected — delivery skipped");
    return skip("not_connected");
  }
  logger.info(
    `[WhatsApp] Integration found: ${integration._id} (tenant ${integration.tenantId}, connected: ${integration.connected})`,
  );

  if (!isWhatsAppConfigured()) {
    logger.warn(
      `[whatsapp] WhatsApp Business is connected (${integration.config?.phone}) but server-level Meta credentials are missing (WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN) — bill ${bill._id} saved without delivery`,
    );
    return skip("server_not_configured");
  }

  summary.attempted = true;
  const cfg = whatsAppConfig();
  logger.info(`[WhatsApp] Sender Phone Number ID configured: ${cfg.phoneNumberId}`);
  const previous = bill.whatsappDelivery ?? {};
  const attempts = Number(previous.attempts ?? 0) + 1;
  const to = phoneCheck.phone;
  summary.recipientPhone = to;
  const caption = buildBillCaption(bill, user?.orgName, cfg.currencySymbol);

  let document;
  try {
    document = await prepareBillDocument(bill, cfg.publicUrl);
  } catch (err) {
    // Unable to build the document — record failure, never block the bill.
    const message = err?.message ?? String(err);
    logger.error(`[whatsapp] could not prepare document for bill ${bill._id}: ${message}`);
    await persistDelivery(bill._id, {
      status: "failed",
      recipientPhone: to,
      messageId: null,
      sentAt: null,
      failedAt: new Date(),
      errorCode: "document_error",
      errorMessage: message,
      attempts,
    });
    summary.status = "failed";
    summary.errorCode = "document_error";
    summary.errorMessage = message;
    logger.info(traceLog(trace, true, `failed (document_error)`));
    return summary;
  }

  const payload = buildMessagePayload(bill, to, document, caption, user?.orgName);
  logger.info(`[WhatsApp] Sending message... (type: ${payload.type})`);
  try {
    const result = await callMetaApi(payload);
    if (result.ok) {
      logger.info(`[WhatsApp] Message ID: ${result.messageId}`);
      const record = {
        status: "sent",
        recipientPhone: to,
        messageId: result.messageId,
        sentAt: new Date(),
        failedAt: null,
        errorCode: null,
        errorMessage: null,
        attempts,
      };
      await persistDelivery(bill._id, record);
      summary.status = "sent";
      summary.messageId = result.messageId;
      logger.info(traceLog(trace, true, "sent"));
      return summary;
    }
    await persistDelivery(bill._id, {
      status: "failed",
      recipientPhone: to,
      messageId: null,
      sentAt: null,
      failedAt: new Date(),
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      attempts,
    });
    summary.status = "failed";
    summary.errorCode = result.errorCode;
    summary.errorMessage = result.errorMessage;
    logger.info(traceLog(trace, true, `failed (${result.errorCode})`));
    return summary;
  } catch (err) {
    const message = err?.message ?? String(err);
    logger.error(`[whatsapp] network error delivering bill ${bill._id}: ${message}`);
    await persistDelivery(bill._id, {
      status: "failed",
      recipientPhone: to,
      messageId: null,
      sentAt: null,
      failedAt: new Date(),
      errorCode: "network_error",
      errorMessage: message,
      attempts,
    });
    summary.status = "failed";
    summary.errorCode = "network_error";
    summary.errorMessage = message;
    logger.info(traceLog(trace, true, "failed (network_error)"));
    return summary;
  }
}

// Safe view of the persisted delivery state for API responses. Never exposes
// tokens or credentials — only the business phone number and Meta error text.
export function formatWhatsAppDelivery(delivery) {
  const d = delivery ?? {};
  return {
    status: d.status ?? "not_attempted",
    reason: d.reason ?? null,
    recipientPhone: d.recipientPhone ?? null,
    messageId: d.messageId ?? null,
    sentAt: d.sentAt ?? null,
    failedAt: d.failedAt ?? null,
    skippedAt: d.skippedAt ?? null,
    errorCode: d.errorCode ?? null,
    errorMessage: d.errorMessage ?? null,
    attempts: d.attempts ?? 0,
  };
}

// Manual send / retry entry point used by the routes. Ownership is enforced
// here (createdBy scope) so a bill can only be delivered by its own org.
export async function sendReportBillWhatsApp({ id, userId, orgName = "" }) {
  const rb = await ReportBill.findOne({ _id: id, createdBy: userId });
  if (!rb) throw ApiError.notFound("Bill not found");
  if (!isSalesBill(rb.toObject())) {
    throw ApiError.badRequest("WhatsApp delivery is only available for sales bills");
  }
  const delivery = await deliverBillToWhatsApp({
    bill: rb.toObject(),
    user: { _id: userId, orgName },
  });
  const fresh = await ReportBill.findById(rb._id).lean();
  const result = fresh ?? rb.toObject();
  return { delivery, bill: result };
}
