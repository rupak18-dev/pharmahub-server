import crypto from "node:crypto";

export function generateId() {
  return crypto.randomUUID();
}

export function generateNumericId(length = 8) {
  return crypto
    .randomInt(0, 10 ** length)
    .toString()
    .padStart(length, "0");
}

export function generateBarcode() {
  return `PH-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

export function generateInvoiceNo() {
  return `INV-${Date.now().toString().slice(-8)}`;
}

export function generateBatchNumber(prefix, date = new Date(), seq = 1) {
  const yy = String(date.getFullYear()).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return `${prefix}-${yy}${mm}-${String(seq).padStart(2, "0")}`;
}
