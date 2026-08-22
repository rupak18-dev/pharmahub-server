import fs from "node:fs";
import path from "node:path";

import { uploadsDir } from "../middlewares/upload.js";

// Dependency-free invoice PDF generator. Produces a genuine, self-contained PDF
// (A4, Helvetica, simple text layout) from the fields of a persisted bill so the
// WhatsApp delivery can attach a real invoice document even when the bill was
// created manually (no uploaded image to forward). Text is restricted to the
// PDF WinAnsi set — ₹ is rendered as "Rs." to keep the file fully ASCII.

const PAGE_WIDTH = 595;
const MARGIN = 50;
const LINE = 16;

// Generated invoices live under /uploads/generated/ (inside the uploads root so
// storedFilePath() guards and static serving keep working unchanged).
export const generatedBillDir = path.join(uploadsDir, "generated");
fs.mkdirSync(generatedBillDir, { recursive: true });

const CURRENCY_RS = "Rs.";

function ascii(text) {
  return String(text ?? "")
    .replace(/₹/g, CURRENCY_RS)
    .replace(/[\u0080-\uffff]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function money(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return `${CURRENCY_RS} 0.00`;
  const formatted = n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${CURRENCY_RS} ${formatted}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function buildContent({
  orgName,
  invoiceNumber,
  invoiceDate,
  customerName,
  customerPhone,
  items = [],
  totals = {},
}) {
  const S = [];
  let y = 800;

  const text = (t, { font = "F1", size = 10 } = {}) => {
    S.push(`BT /${font} ${size} Tf 1 0 0 1 ${MARGIN} ${y} Tm (${ascii(t)}) Tj ET`);
    y -= LINE;
  };
  const line = (gap = 6) => {
    y -= gap;
  };

  text(String(orgName ?? "PharmaHub").toUpperCase(), { font: "F2", size: 16 });
  text("INVOICE", { font: "F2", size: 12 });
  text(`Invoice No: ${invoiceNumber ?? ""}`);
  text(`Date: ${formatDate(invoiceDate)}`);
  line(12);
  text("Bill To", { font: "F2", size: 11 });
  text(customerName ?? "");
  if (customerPhone) text(`Phone: ${customerPhone}`);
  line(12);
  text("Items", { font: "F2", size: 11 });
  text("# Item                        Qty   Rate    Disc%  GST%  Amount", { font: "F2", size: 9 });

  const rows = Array.isArray(items) ? items : [];
  for (const [i, item] of rows.entries()) {
    const name = String(item.medicineName ?? item.itemName ?? "Item").slice(0, 30);
    const qty = item.quantity ?? 0;
    const rate = item.unitPrice ?? item.unitCost ?? 0;
    const disc = item.discountPct ?? 0;
    const gst = item.gstRate ?? 0;
    const amount = item.lineTotal ?? 0;
    const qtyFmt = Number.isInteger(qty) ? qty : qty.toFixed(2);
    const rateFmt = Number(rate).toFixed(2);
    text(`${i + 1}. ${name}  ${qtyFmt} x ${rateFmt}  ${disc}%  ${gst}%  = ${money(amount)}`, {
      size: 9,
    });
  }

  line(10);
  text(`Subtotal: ${money(totals.subtotal)}`);
  if (totals.discountAmount) text(`Discount: ${money(totals.discountAmount)}`);
  text(`Taxable: ${money(totals.taxableAmount)}`);
  text(`GST: ${money(totals.totalGst)}`);
  text(`Grand Total: ${money(totals.grandTotal)}`, { font: "F2" });

  y = 60;
  text(`Thank you for your purchase from ${String(orgName ?? "PharmaHub").toUpperCase()}.`, {
    size: 9,
  });

  return S.join("\n") + "\n";
}

function buildPdf(payload) {
  const content = buildContent(payload);

  const objects = {
    1: "<< /Type /Catalog /Pages 2 0 R >>",
    2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    3: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
    4: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    5: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    6: `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}endstream`,
  };

  let pdf = "%PDF-1.4\n";
  const offsets = {};
  for (const id of Object.keys(objects)) {
    offsets[id] = Buffer.byteLength(pdf, "latin1");
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${Object.keys(objects).length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i <= Object.keys(objects).length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${Object.keys(objects).length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(pdf, "latin1");
}

function safeFilename(value, fallback) {
  const cleaned = String(value ?? "").replace(/[^a-zA-Z0-9._-]/g, "");
  return cleaned || fallback;
}

// Persists a real invoice PDF for the bill and returns the same document
// descriptor shape the upload flow produces (relative path, disk path, mime).
export async function generateInvoiceDocument(bill, { publicUrl = "" } = {}) {
  const pdf = buildPdf({
    orgName: bill.orgName || "PharmaHub",
    invoiceNumber: bill.invoice?.invoiceNumber ?? "",
    invoiceDate: bill.invoice?.invoiceDate ?? bill.createdAt ?? new Date(),
    customerName: bill.customer?.name ?? "",
    customerPhone: bill.customer?.phone ?? "",
    items: bill.items ?? [],
    totals: bill.totals ?? {},
  });

  const filePath = `/uploads/generated/${bill._id}.pdf`;
  await fs.promises.writeFile(path.join(generatedBillDir, `${bill._id}.pdf`), pdf);

  return {
    path: filePath,
    absPath: path.join(generatedBillDir, `${bill._id}.pdf`),
    filename: safeFilename(bill.invoice?.invoiceNumber, bill._id.toString()).concat(".pdf"),
    mimeType: "application/pdf",
    link: `${String(publicUrl).replace(/\/$/, "")}${filePath}`,
  };
}
