// Phone-number extraction from OCR text — a pure, regex-based layer on top of
// the Tesseract output (see ./ocr.service.js and ./billExtraction.service.js).
//
// A bill can contain many numbers (supplier contact lines, customer mobiles,
// support helplines, invoice numbers, GSTINs, dates, HSN codes, PIN codes,
// amounts). Only numbers that actually look like Indian mobile numbers are
// kept, then each one is classified by the text around it so a supplier's
// phone is never silently reused as the customer's WhatsApp recipient.
//
// Candidates are exposed with the surrounding-context label and a role:
//   role "supplier"  -> appears in the supplier header / near supplier terms
//   role "customer"  -> appears near customer / buyer / party / consignee terms
//   role "unknown"   -> no reliable signal; never auto-used for delivery
//
// Confidence is never invented: it is the per-line OCR confidence reported by
// Tesseract (falling back to the document-level confidence), or null when no
// real score is available.

import { isValidIndianPhone, normalizeIndianPhone } from "../utils/phone.js";

// A plausible phone run: 9+ characters made of digits and phone separators.
// The comma is intentionally excluded so "9292000166, 9010252225" yields two
// candidates instead of one merged blob.
const PHONE_RUN_RE = /\+?\d[\d\s\-().]{8,20}/g;

// Table header that marks the end of the purchase-invoice header region.
const TABLE_START_RE =
  /\b(product\s*name|particulars|item\s*(?:description)?|description|medicine)\b.*\b(batch|qty|rate|mrp)\b/i;

// "party" is split out from the other customer labels: the label appears at the
// very top of supplier invoices (where it describes the pharmacy buying), so an
// unlabelled supplier phone below it must not be captured by it.
const CUSTOMER_LABEL_RE =
  /\b(customer|buyer|bill\s*to|ship\s*to|consignee|recipient|deliver(?:y)?\s*to)\b/i;
const PARTY_LABEL_RE = /\bparty\b/i;
const SUPPLIER_LABEL_RE = /\b(supplier|vendor|distributor|manufacturer|wholesaler|seller)\b/i;
const PHONE_LABEL_RE = /\b(phone|mobile|mob(?:ile)?|contact|tel(?:ephone)?|ph|whatsapp)\b/i;

const LABEL_TITLE = {
  customer: "Customer",
  buyer: "Buyer",
  "bill to": "Bill To",
  "ship to": "Ship To",
  consignee: "Consignee",
  recipient: "Recipient",
  "delivery to": "Delivery To",
  "deliver to": "Delivery To",
  party: "Party",
  supplier: "Supplier",
  vendor: "Vendor",
  distributor: "Distributor",
  manufacturer: "Manufacturer",
  wholesaler: "Wholesaler",
  seller: "Seller",
  phone: "Phone",
  mobile: "Mobile",
  mob: "Mobile",
  contact: "Contact",
  tel: "Phone",
  telephone: "Phone",
  ph: "Phone",
  whatsapp: "WhatsApp",
};

function labelTitle(label) {
  return (
    LABEL_TITLE[
      String(label ?? "")
        .toLowerCase()
        .trim()
    ] ?? String(label ?? "").trim()
  );
}

// Returns the label that triggered a regex match, so the context field is the
// actual word found in the document ("Phone", "Mobile", "Party", ...).
function firstLabel(text, re) {
  const m = String(text ?? "").match(re);
  if (!m) return "";
  return labelTitle(m[0]);
}

// Classifies a candidate on OCR line `index` by the surrounding lines.
//
// Only labels on the same line or above are considered: a label below the
// number describes a different field and must not reclassify it (e.g. a
// pharmacy's own header phone sitting above a "Customer: ..." block).
function classifyPhoneRole(
  lines,
  index,
  { supplierName = "", partyName = "", documentType = "purchase_invoice", tableStart = -1 },
) {
  const same = lines[index] ?? "";
  const above = lines.slice(Math.max(0, index - 2), index).join(" | ");
  const near = above ? `${above} | ${same}` : same;

  const sameCustomer = firstLabel(same, CUSTOMER_LABEL_RE);
  if (sameCustomer) return { role: "customer", context: sameCustomer };
  const sameSupplier = firstLabel(same, SUPPLIER_LABEL_RE);
  if (sameSupplier) return { role: "supplier", context: sameSupplier };
  const sameParty = firstLabel(same, PARTY_LABEL_RE);
  if (sameParty) return { role: "customer", context: sameParty };

  const aboveCustomer = firstLabel(above, CUSTOMER_LABEL_RE);
  if (aboveCustomer) return { role: "customer", context: aboveCustomer };
  const aboveSupplier = firstLabel(above, SUPPLIER_LABEL_RE);
  if (aboveSupplier) return { role: "supplier", context: aboveSupplier };

  // Name matches use the same window as labels: a name that appears much
  // further up (e.g. "Terms & Conditions FOR <supplier>" at the bottom of an
  // invoice) must not capture unrelated numbers below it.
  const nameWindow = lines.slice(Math.max(0, index - 2), index).join(" | ");
  if (supplierName && nameWindow.includes(supplierName)) {
    return { role: "supplier", context: "supplier header" };
  }
  if (partyName && nameWindow.includes(partyName)) {
    return { role: "customer", context: "party match" };
  }

  const phoneLabel = firstLabel(near, PHONE_LABEL_RE);
  if (phoneLabel) {
    // Unlabelled-in-role phones inside the supplier header of a purchase
    // invoice are the supplier's contact numbers (the header block starts at
    // the top and runs down to the item table). For sales invoices the header
    // phone belongs to the pharmacy itself, never the customer — so those stay
    // "unknown" and are never auto-selected for delivery.
    const inHeader = tableStart === -1 ? index <= 12 : index < tableStart;
    if (documentType === "purchase_invoice" && inHeader) {
      return { role: "supplier", context: "header phone" };
    }
    return { role: "unknown", context: phoneLabel };
  }
  return { role: "unknown", context: "unlabeled" };
}

// Flattens the tesseract Page lines into a plain [{ text, confidence }] list
// when present, else falls back to the raw split text.
function asLines(lines, docConfidence) {
  if (Array.isArray(lines) && lines.length > 0) {
    const first = lines[0];
    if (typeof first === "string")
      return lines.map((l) => ({ text: l, confidence: docConfidence ?? null }));
    if (first && typeof first.text === "string") {
      return lines.map((l) => ({
        text: String(l.text ?? ""),
        confidence: Number.isFinite(Number(l.confidence))
          ? Number(l.confidence)
          : (docConfidence ?? null),
      }));
    }
  }
  return [];
}

function dedupe(candidates) {
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    const key = `${c.role}|${c.normalizedNumber}|${c.context}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/**
 * Extracts all Indian-mobile candidates from OCR lines and classifies them.
 * `lines` may be an array of plain strings or an array of
 * `{ text, confidence }` objects (as returned by `runOcr`).
 *
 * Returns [{ number, normalizedNumber, confidence, source: "ocr", context, role }]
 */
export function extractPhoneCandidates(lines, opts = {}) {
  const {
    supplierName = "",
    partyName = "",
    documentType = "purchase_invoice",
    docConfidence = null,
  } = opts;
  const cleanLines = asLines(lines, docConfidence);
  const textLines = cleanLines.map((l) => l.text);
  if (textLines.length === 0) return [];

  const tableStart = textLines.findIndex((l) => TABLE_START_RE.test(l));
  const candidates = [];

  cleanLines.forEach((line, i) => {
    const runs = String(line.text ?? "").match(PHONE_RUN_RE) ?? [];
    if (runs.length === 0) return;

    const classified = classifyPhoneRole(textLines, i, {
      supplierName,
      partyName,
      documentType,
      tableStart,
    });
    for (const run of runs) {
      const cleaned = String(run).replace(/[\s\-().]/g, "");
      if (!isValidIndianPhone(cleaned)) continue;
      candidates.push({
        number: cleaned,
        normalizedNumber: normalizeIndianPhone(cleaned),
        confidence:
          line.confidence == null ? null : Math.max(0, Math.min(99, Math.round(line.confidence))),
        source: "ocr",
        context: classified.context,
        role: classified.role,
      });
    }
  });

  return dedupe(candidates);
}

// Best customer candidate: the highest-confidence phone classified as customer
// (used to prefill the Customer / WhatsApp Number field). Empty when none.
export function deriveCustomerPhone(candidates) {
  const customers = (candidates || []).filter((c) => c.role === "customer" && c.normalizedNumber);
  if (customers.length === 0) return "";
  return [...customers].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0]
    .normalizedNumber;
}

// Distinct supplier numbers (kept separately — never used for delivery).
export function deriveSupplierPhones(candidates) {
  return [
    ...new Set(
      (candidates || []).filter((c) => c.role === "supplier").map((c) => c.normalizedNumber),
    ),
  ];
}
