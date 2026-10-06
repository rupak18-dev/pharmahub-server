// Bill image extraction — the OCR seam for the Report Data "Upload Bill" flow.
//
// OCR runs entirely on the server: the uploaded image is passed to the local
// Tesseract engine (see ./ocr.service.js) and the recognised text is parsed
// into structured bill fields by the pure functions below. Results are never
// hardcoded; if the engine cannot read the document the flow degrades to a
// manual review form instead of inventing data.

import { runOcr } from "./ocr.service.js";
import fs from "node:fs";
import {
  deriveCustomerPhone,
  deriveSupplierPhones,
  extractPhoneCandidates,
} from "./phoneExtraction.service.js";

/* ---------------------------------------------------------------------
   Small helpers
   --------------------------------------------------------------------- */

const splitLines = (text) =>
  String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim());

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const moneyNumber = (raw) => {
  if (raw === null || raw === undefined) return null;
  const v = String(raw).replace(/,/g, "").trim();
  if (!/^\d+(\.\d+)?$/.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

const percentNumber = (raw) => {
  const n = moneyNumber(String(raw ?? "").replace(/[%\s]/g, ""));
  return n === null ? null : Math.min(100, Math.max(0, n));
};

// Normalizes "10-08-2026", "10/08/2026", "10.08.2026", "10-08-26" to
// yyyy-mm-dd. Ambiguous d/m/y (Indian invoices) is assumed over m/d/y.
function normalizeDate(raw) {
  if (!raw) return "";
  const m = String(raw)
    .trim()
    .match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (!m) return "";
  let [, d, mo, y] = m;
  if (Number(d) < 1 || Number(d) > 31 || Number(mo) < 1 || Number(mo) > 12) return "";
  if (y.length === 2) y = Number(y) >= 50 ? `19${y}` : `20${y}`;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

// Reasonably complete Indian amount-in-words converter (hundreds/lakhs/crores).
const WORD_NUMBERS = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
function wordsToNumber(words) {
  const tokens = String(words ?? "")
    .toLowerCase()
    .replace(/and\b/g, "")
    .split(/[^a-z]+/)
    .filter(Boolean);
  let total = 0;
  let current = 0;
  for (const t of tokens) {
    if (t === "hundred") {
      current *= 100;
    } else if (t === "thousand") {
      total += current * 1000;
      current = 0;
    } else if (t === "lakh" || t === "lac") {
      total += current * 100000;
      current = 0;
    } else if (t === "crore") {
      total += current * 10000000;
      current = 0;
    } else if (t in WORD_NUMBERS) {
      current += WORD_NUMBERS[t];
    }
  }
  const result = total + current;
  return result > 0 ? result : null;
}

/* ---------------------------------------------------------------------
   Document type detection
   --------------------------------------------------------------------- */

export function detectDocumentType(text) {
  const t = String(text ?? "");
  if (
    /tax invoice|gst invoice/i.test(t) &&
    /party\s*name|buyer\b|consignee|purchased\s*by|m\.?\/?s/i.test(t)
  ) {
    return "purchase_invoice";
  }
  if (
    /payment\s*receipt|amount\s+received|received\s+with\s+thanks|acknowledge\s+receipt/i.test(t)
  ) {
    return "payment_receipt";
  }
  if (/cash\s*memo|cash\s+bill|cash\s*sale|retail\s*sale/i.test(t)) {
    return "sales_invoice";
  }
  // Supplier GST invoices make up the vast majority of pharma uploads.
  return "purchase_invoice";
}

/* ---------------------------------------------------------------------
   Header parsing (supplier, party, GSTIN, invoice no/date)
   --------------------------------------------------------------------- */

const GSTIN_RE = /\b([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/g;

function extractSupplier(text) {
  const lines = splitLines(text);
  for (const line of lines) {
    if (!line) continue;
    let name = line.replace(
      /\s+(?:GST|TAX|CREDIT|DEBIT)?\s*(?:INVOICE|CASH MEMO|RECEIPT|CHALLAN)\b.*$/i,
      "",
    );
    name = name.replace(/[|:;].*$/, "").trim();
    if (
      /[A-Za-z]{3,}/.test(name) &&
      /[A-Z]/.test(name) &&
      !/^(phone|gstin|dl\b|dl\s*no|pan|party|transport|cash|invoice)/i.test(name)
    ) {
      return name.slice(0, 80);
    }
  }
  return "";
}

function extractHeader(text) {
  const t = String(text ?? "");

  const gstins = [...t.matchAll(GSTIN_RE)].map((m) => m[1]);
  // Invoice number: prefer an explicit "Invoice No / Number / #" label, then a
  // colon-labelled "Invoice:" value. The captured value must contain a digit so
  // "GST INVOICE Party..." never wins.
  const INV_VALUE = /([A-Z0-9][A-Z0-9/-]*[0-9][A-Z0-9/-]*)/;
  const invoiceNoM =
    t.match(
      new RegExp(`\\binvoice\\s*(?:no\\.?|number|#)\\s*[:#]?\\s*${INV_VALUE.source}\\b`, "i"),
    ) || t.match(new RegExp(`\\binvoice\\s*[:#]\\s*${INV_VALUE.source}\\b`, "i"));
  const invoiceDateM = t.match(/\binvoice\s*date\s*:?\s*(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})\b/i);
  const dateM = t.match(
    /\b(?:date|cash\s*date|bill\s*date)\s*:?\s*(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})\b/i,
  );
  const phoneM = t.match(/\bphone\s*:?\s*([0-9][0-9,\s]{8,24})/i);

  // Party name: text after the "Party Name :" label (possibly across a
  // newline). OCR often merges it with an address line, so take the trailing
  // all-caps run of the captured chunk.
  let party = "";
  const partyChunk = t.match(/party\s*name\s*:?\s*\n?\s*([^\n]{1,140})/i);
  if (partyChunk) {
    const run = partyChunk[1].match(/([A-Z][A-Z0-9&.'/-]*(?:\s+[A-Z][A-Z0-9&.'/-]*)+)\s*$/);
    if (run) party = run[1].trim().slice(0, 60);
  }

  // Supplier address: the 1-2 lines right after the supplier title that look
  // like an address (contain a digit). Trailing "Party Name :" is stripped.
  let supplierAddress = "";
  const lines = splitLines(t);
  const supplierName = extractSupplier(t);
  const supplierIdx = lines.findIndex((l) => l.startsWith(supplierName));
  for (let i = supplierIdx + 1; i < lines.length && supplierAddress.length < 140; i += 1) {
    let line = lines[i]
      .replace(/party\s*name\s*:.*$/i, "")
      .replace(/\s*\|.*$/, "")
      .trim();
    line = line.replace(/\s*(?:HPR|HFR|DL|PAN|AADHAR)\s*ID\s*:.*$/i, "").trim();
    if (!line) continue;
    if (/\d/.test(line)) supplierAddress = supplierAddress ? `${supplierAddress}, ${line}` : line;
    if (supplierAddress && i > supplierIdx + 2) break;
  }

  const supplierGstin = gstins[0] || "";
  const partyGstin = gstins[1] || "";

  return {
    supplier: {
      name: supplierName,
      gstin: supplierGstin,
      address: supplierAddress,
      phone: phoneM?.[1]?.replace(/\s+/g, " ").trim() ?? "",
    },
    party: { name: party, gstin: partyGstin },
    invoiceNumber: invoiceNoM ? invoiceNoM[1].replace(/\s+$/, "") : "",
    invoiceDate: normalizeDate(invoiceDateM?.[1] || dateM?.[1] || ""),
  };
}

/* ---------------------------------------------------------------------
   Line-item parsing
   --------------------------------------------------------------------- */

const ITEM_LABELS = {
  hsn: ["hsn", "hsn code", "hsn no", "hsn no."],
  pack: ["pack", "packing", "pack size"],
  batch: ["batch", "batch no", "batch no.", "batch number", "batch #", "lot no", "lot"],
  expiry: ["expiry", "exp", "expiry date", "exp date", "batch expiry"],
  quantity: ["quantity", "qty", "qty.", "qty ", "units", "no. of boxes"],
  free: ["free", "free qty", "free quantity", "scheme"],
  manufacturer: ["mfg", "manufacturer", "mfg.", "company", "maker"],
  rate: ["rate", "unit rate", "unit price", "rate/unit"],
  mrp: ["mrp", "m.r.p", "max retail price"],
  discount: ["disc", "disc.", "discount", "discount %", "disc%"],
  sgstRate: ["sgst", "sgst %", "sgst%", "sgst rate"],
  cgstRate: ["cgst", "cgst %", "cgst%", "cgst rate"],
  gstRate: ["gst", "gst %", "gst%", "gst rate", "total tax %"],
  sgstAmount: ["sgst amount", "sgst amt", "sgst amt.", "sgst value"],
  cgstAmount: ["cgst amount", "cgst amt", "cgst amt.", "cgst value"],
  taxableAmount: ["taxable value", "taxable amount", "amount", "value", "total value", "net value"],
};

function fillFromLabel(line, item) {
  const lower = line.toLowerCase();
  for (const [key, labels] of Object.entries(ITEM_LABELS)) {
    const label = labels.find(
      (l) => lower.startsWith(`${l}:`) || lower.startsWith(`${l} :`) || lower === l,
    );
    if (!label) continue;
    const value = line
      .slice(line.toLowerCase().indexOf(label) + label.length)
      .replace(/^[\s:]+/, "")
      .trim();
    if (!value) continue;
    const num = moneyNumber(value);
    switch (key) {
      case "hsn":
        item.hsnCode = value.slice(0, 12);
        break;
      case "pack":
        item.pack = value.slice(0, 12);
        break;
      case "batch":
        item.batchNumber = value.slice(0, 24);
        break;
      case "expiry": {
        const norm = value.match(/\d{1,2}\/\d{2,4}/)?.[0];
        if (norm) item.expiryDate = norm;
        break;
      }
      case "quantity":
        item.quantity = num ?? 0;
        break;
      case "free":
        item.freeQuantity = num ?? 0;
        break;
      case "manufacturer":
        item.manufacturer = value.replace(/\s+/g, " ").slice(0, 40);
        break;
      case "rate":
        item.unitCost = num ?? 0;
        break;
      case "mrp":
        item.mrp = num ?? 0;
        break;
      case "discount":
        item.discountPct = percentNumber(value) ?? 0;
        break;
      case "sgstRate":
        item.sgstRate = percentNumber(value) ?? 0;
        break;
      case "cgstRate":
        item.cgstRate = percentNumber(value) ?? 0;
        break;
      case "gstRate":
        item.gstRate = percentNumber(value) ?? 0;
        break;
      case "sgstAmount":
        item.sgstAmount = num ?? 0;
        break;
      case "cgstAmount":
        item.cgstAmount = num ?? 0;
        break;
      case "taxableAmount":
        item.lineTotal = num ?? 0;
        break;
      default:
        break;
    }
    return true;
  }
  return false;
}

// Builds line totals from the parsed pieces (mirrors the server recompute the
// save path applies, so the review form and the final record agree).
function computeItemTotals(item) {
  const qty = Number(item.quantity) || 0;
  const rate = Number(item.unitCost) || 0;
  const gross = qty * rate;
  const discount = (gross * (Number(item.discountPct) || 0)) / 100;
  const taxable = gross - discount;
  const explicitSplit = Number(item.sgstRate) > 0 || Number(item.cgstRate) > 0;
  const effSgst = explicitSplit ? Number(item.sgstRate) : Number(item.gstRate) / 2;
  const effCgst = explicitSplit ? Number(item.cgstRate) : Number(item.gstRate) / 2;
  const sgst = (taxable * effSgst) / 100;
  const cgst = (taxable * effCgst) / 100;
  if (!item.sgstRate && effSgst) item.sgstRate = Math.round(effSgst * 100) / 100;
  if (!item.cgstRate && effCgst) item.cgstRate = Math.round(effCgst * 100) / 100;
  item.taxableAmount = Math.round(taxable * 100) / 100;
  item.sgstAmount = Math.round(sgst * 100) / 100;
  item.cgstAmount = Math.round(cgst * 100) / 100;
  item.gstAmount = Math.round((sgst + cgst) * 100) / 100;
  item.lineTotal = Math.round((taxable + sgst + cgst) * 100) / 100;
  return item;
}

// Parses invoices whose OCR produces "Label: value" pairs on their own lines.
function parseLabeledItems(lines) {
  const items = [];
  let current = null;
  const START_RE = /^(product|medicine|item|particulars|description|drug|name)\s*:?\s*(.*)$/i;

  for (const line of lines) {
    if (!line) continue;
    const start = line.match(START_RE);
    if (start) {
      if (current && current.medicineName) items.push(current);
      current = {
        medicineName: start[2].trim(),
        hsnCode: "",
        pack: "",
        batchNumber: "",
        expiryDate: "",
        quantity: 0,
        freeQuantity: 0,
        unitCost: 0,
        mrp: 0,
        discountPct: 0,
        sgstRate: 0,
        cgstRate: 0,
        gstRate: 0,
        sgstAmount: 0,
        cgstAmount: 0,
        gstAmount: 0,
        taxableAmount: 0,
        lineTotal: 0,
        manufacturer: "",
      };
      continue;
    }
    if (current) fillFromLabel(line, current);
  }
  if (current && current.medicineName) items.push(current);

  return items.map((it) => computeItemTotals(it)).filter((it) => it.medicineName);
}

// Parses a single tabulated item row from the OCR text.
function parseTabularRow(line) {
  const row = line.trim();
  if (!row || row.length < 8) return null;
  if (!/[A-Za-z]/.test(row)) return null;
  // Totals / meta lines are never item rows.
  if (
    /^(total|grand\s*total|sub\s*total|gross|gst|sgst|cgst|class|our|print|rs\.|charges|irn|terms|goods|bill|all|download|marg|phone|dl\b|dl\s*no|gstin|invoice|party|transport|cash|pan|round|disc|taxable|subtotal|tcs|tds)/i.test(
      row,
    )
  ) {
    return null;
  }

  const batchM = row.match(/\b([A-Z]{1,4}[0-9]{5,9})\b/);
  const expiryM = row.match(/\b(\d{1,2}\/\d{2}(?:\/\d{2,4})?)\b/);
  const hsnM = row.match(/\b(3\d{5,7})\b/);
  const allNums = (row.match(/\d+(?:\.\d+)?/g) || []).map(Number);

  // An item row carries a batch number, or an HSN plus rate-like numbers.
  if (!batchM && !(hsnM && allNums.filter((n) => n >= 1).length >= 3)) return null;

  const item = {
    medicineName: "",
    hsnCode: hsnM?.[1] || "",
    pack: "",
    batchNumber: batchM?.[1] || "",
    expiryDate: "",
    quantity: 0,
    freeQuantity: 0,
    unitCost: 0,
    mrp: 0,
    discountPct: 0,
    sgstRate: 0,
    cgstRate: 0,
    sgstAmount: 0,
    cgstAmount: 0,
    gstAmount: 0,
    taxableAmount: 0,
    lineTotal: 0,
    manufacturer: "",
  };

  if (expiryM) item.expiryDate = expiryM[1];

  let work = row;
  // Strip the sequence number when it is followed by the HSN or a product.
  work = work.replace(/^\s*\d{1,3}\s+(?=\d{6,8}\b|[A-Za-z])/, " ");

  if (batchM) {
    // Product name = the clean slice between the HSN and the batch number
    // (pack size sits right before the batch). This keeps embedded numbers in
    // names like "HUMINSULIN30/70CAR" out of the decimal columns.
    const batchIdx = row.indexOf(batchM[1]);
    let productRegion = batchIdx > 0 ? row.slice(0, batchIdx) : "";
    productRegion = productRegion
      .replace(/^\s*\d{1,3}\s+/, " ")
      .replace(new RegExp(`\\b${escapeRegExp(hsnM?.[1] || "____NONE____")}\\b`), " ")
      .replace(/\s*\d{1,3}\s*$/, "")
      .replace(/[|:;]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (productRegion) item.medicineName = productRegion.slice(0, 120);

    // Everything from the batch onward: pack / qty / free / mfg / decimals.
    work = row.slice(batchIdx);
    work = work.replace(new RegExp(`\\b${escapeRegExp(batchM[1])}\\b`), " ");
    if (hsnM) work = work.replace(new RegExp(`\\b${escapeRegExp(hsnM[1])}\\b`), " ");
    const packM = row.match(new RegExp(`(\\d{1,3})\\s+${escapeRegExp(batchM[1])}`));
    if (packM) item.pack = packM[1];
  } else {
    if (hsnM) work = work.replace(new RegExp(`\\b${escapeRegExp(hsnM[1])}\\b`), " ");
  }
  if (expiryM) work = work.replace(new RegExp(`\\b${escapeRegExp(expiryM[1])}\\b`), " ");

  // Quantity and free quantity sit right after the expiry date.
  const qtyM = work.match(/^\s*(\d{1,4})\s*(?:(-|\d{1,3}))?\s*/);
  if (qtyM && qtyM[1]) {
    item.quantity = Number(qtyM[1]) || 0;
    if (qtyM[2] && qtyM[2] !== "-") item.freeQuantity = Number(qtyM[2]) || 0;
    work = work.slice(qtyM[0].length);
  }

  // Remaining decimals in column order: rate, MRP, disc%, sgst%, sgst amt,
  // cgst%, cgst amt, line value.
  work = work.replace(/\s*[|,]\s*/g, " ");
  const decimals = (work.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  if (decimals.length >= 2) {
    item.unitCost = decimals[0];
    item.mrp = decimals[1];
    if (decimals.length >= 3) item.discountPct = decimals[2];
    if (decimals.length >= 5) {
      item.sgstRate = decimals[3];
      item.sgstAmount = decimals[4];
    }
    if (decimals.length >= 7) {
      item.cgstRate = decimals[5];
      item.cgstAmount = decimals[6];
    }
    if (decimals.length >= 8) item.lineTotal = decimals[7];
  }

  // Manufacturer: the pure-alpha token(s) sitting right before the rate.
  const mfgM = work.match(/\b([A-Z][A-Z0-9]{1,11}(?:\s+[A-Z][A-Z0-9]{1,11})?)\s+\d/);
  if (mfgM) item.manufacturer = mfgM[1];

  if (!item.medicineName) {
    // No batch (rare layout): product name = leftover after removing every
    // known token, excluding the numbers that belong to the name itself.
    let name = work
      .replace(/\b\d+(?:\.\d+)?\b/g, " ")
      .replace(/\s*[-–]\s*/g, " ")
      .replace(/[|/\\:_;,+()[\]]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (/\d/.test(name)) name = name.replace(/\s+[A-Z]{1,10}$/, "").trim();
    item.medicineName = name.slice(0, 120);
  }

  if (!item.medicineName) return null;
  return computeItemTotals(item);
}

function parseTabularItems(text) {
  const items = [];
  const lines = splitLines(text);
  // Restrict the scan to the line-item region: from the table header down to
  // the first totals line, but keep the whole doc as a fallback.
  let startIdx = lines.findIndex((l) =>
    /\b(?:product\s*name|particulars|item\s*(?:description)?|description|medicine)\b.*\b(?:batch|qty|rate|mrp)\b/i.test(
      l,
    ),
  );
  let endIdx = lines.findIndex(
    (l, i) =>
      i > Math.max(0, startIdx) &&
      /grand\s*total|total\s*gst|sgst\s*pay|gst\s*5|gst\s*12|round\s*off|amount\s*in\s*words/i.test(
        l,
      ),
  );
  if (startIdx === -1) startIdx = 0;
  if (endIdx === -1) endIdx = lines.length;
  const region = lines.slice(startIdx, endIdx);

  for (const line of region) {
    const item = parseTabularRow(line);
    if (item) items.push(item);
  }
  return items.slice(0, 50);
}

/* ---------------------------------------------------------------------
   Totals parsing
   --------------------------------------------------------------------- */

const MONEY_IN_LINE = /(\d[\d,]*\.\d{2})/g;

function extractTotals(text) {
  const t = String(text ?? "");
  const totals = {};

  const sgstM = t.match(/sgst\s*pay(?:able|ment)?[^\d\n]{0,20}(\d[\d,]*\.\d{2})/i);
  const cgstM = t.match(/cgst\s*pay(?:able|ment)?[^\d\n]{0,20}(\d[\d,]*\.\d{2})/i);

  // "TOTAL <gross> <disc> <taxable> <sgst> <cgst> <gst>" row. Collect every
  // money value on the line and map positionally (the columns repeat per GST
  // class, so using the FIRST "TOTAL" line is the reliable signal).
  const totalLine = splitLines(t).find((l) => /^total\b/i.test(l));
  const grossM = totalLine ? [...totalLine.matchAll(MONEY_IN_LINE)].map((m) => m[1]) : [];

  if (grossM.length >= 6) {
    totals.subtotal = moneyNumber(grossM[0]);
    totals.discount = moneyNumber(grossM[1]);
    totals.taxableAmount = moneyNumber(grossM[2]);
    totals.totalSGST = moneyNumber(grossM[3]);
    totals.totalCGST = moneyNumber(grossM[4]);
    totals.gstTotal = moneyNumber(grossM[5]);
  } else {
    const taxableM = t.match(
      /(?:taxable|taxable\s*amount|taxable\s*value)[^\d\n]{0,20}(\d[\d,]*\.\d{2})/i,
    );
    if (taxableM) totals.taxableAmount = moneyNumber(taxableM[1]);
  }
  if (sgstM) totals.totalSGST = moneyNumber(sgstM[1]);
  if (cgstM) totals.totalCGST = moneyNumber(cgstM[1]);

  // Printed grand total: whatever money value follows the "Grand Total"
  // label (the OCR often drops it far from the label), falling back to the
  // amount-in-words.
  const gtIdx = t.toLowerCase().indexOf("grand total");
  if (gtIdx !== -1) {
    const after = t.slice(gtIdx + 11);
    const m = after.match(MONEY_IN_LINE);
    if (m) totals.grandTotal = moneyNumber(m[0]);
  }
  if (totals.grandTotal === undefined) {
    const wordsM = t.match(/rs\.?\s*(.+?)\s*(?:only|paise|paisa|\/-|\/–)/i);
    if (wordsM) {
      const n = wordsToNumber(wordsM[1]);
      if (n) totals.grandTotal = n;
    }
  }

  return totals;
}

/* ---------------------------------------------------------------------
   Public parsing API
   --------------------------------------------------------------------- */

export function parseBillDocument(rawText, opts = {}) {
  const text = String(rawText ?? "");
  const warnings = [];

  const header = extractHeader(text);
  const labeled = parseLabeledItems(splitLines(text));
  const tabular = parseTabularItems(text);
  const items = labeled.length >= tabular.length ? labeled : tabular;

  if (items.length === 0) {
    warnings.push("No line items could be identified from the OCR text — add them during review.");
  }
  if (!header.invoiceNumber) {
    warnings.push("Invoice number was not found — enter it during review.");
  }
  if (!header.invoiceDate) {
    warnings.push("Invoice date was not found — enter it during review.");
  }

  const totals = extractTotals(text);
  if (totals.grandTotal === undefined) {
    warnings.push("Printed grand total was not found — reports will use the calculated total.");
  }

  const documentType = detectDocumentType(text);

  // Phone extraction is document-type aware: numbers near the supplier header
  // of a purchase invoice are supplier contacts, numbers near customer/buyer/
  // party terms are customer numbers. Supplier phones are kept separately and
  // never reused as the WhatsApp recipient.
  const lines = opts?.lines ?? splitLines(text);
  const phoneCandidates = extractPhoneCandidates(lines, {
    supplierName: header.supplier?.name,
    partyName: header.party?.name,
    documentType,
    docConfidence: opts?.docConfidence ?? null,
  });
  const customerPhone = deriveCustomerPhone(phoneCandidates);
  const supplierPhones = deriveSupplierPhones(phoneCandidates);

  const fields = {
    invoiceNumber: header.invoiceNumber,
    invoiceDate: header.invoiceDate,
    supplier: { ...header.supplier, phones: supplierPhones },
    party: { ...header.party, phone: customerPhone },
    customerPhone,
    phoneCandidates,
    items,
    subtotal: totals.subtotal ?? 0,
    discount: totals.discount ?? 0,
    taxableAmount: totals.taxableAmount ?? 0,
    totalSGST: totals.totalSGST ?? 0,
    totalCGST: totals.totalCGST ?? 0,
    gstTotal: totals.gstTotal ?? 0,
    printedGrandTotal: totals.grandTotal ?? null,
  };

  return { documentType, fields, warnings };
}

/* ---------------------------------------------------------------------
   Image extraction entry point
   --------------------------------------------------------------------- */

// Magic bytes for the image formats the uploader accepts — anything else is a
// corrupted/renamed file that would only waste an OCR worker on an error.
const IMAGE_MAGIC = [
  { bytes: [0x89, 0x50, 0x4e, 0x47], ext: "png" },
  { bytes: [0xff, 0xd8, 0xff], ext: "jpg" },
];
function isPlausibleImage(file) {
  try {
    const fd = fs.openSync(file.path, "r");
    const buf = Buffer.alloc(12);
    fs.readSync(fd, buf, 0, 12, 0);
    fs.closeSync(fd);
    const isJpegOrPng = IMAGE_MAGIC.some(({ bytes }) =>
      buf.subarray(0, bytes.length).equals(Buffer.from(bytes)),
    );
    const isWebp =
      buf.subarray(0, 4).toString("latin1") === "RIFF" &&
      buf.subarray(8, 12).toString("latin1") === "WEBP";
    return isJpegOrPng || isWebp;
  } catch {
    return false;
  }
}

// OCR is only "confident" when the engine actually read the document well.
// Below this bar (or with zero line items) the result is still returned for
// the review form to prefill, but flagged lowConfidence so the UI clearly
// asks the user to verify before saving instead of presenting garbage as a
// reliable extraction.
const LOW_CONFIDENCE_THRESHOLD = 60;

// Runs OCR on an uploaded bill image and returns a normalized extraction
// result. Genuine failures degrade to { status: "manual" } so the UI falls
// back to a manual review form — extraction is never faked.
export async function extractBillFromImage(file) {
  if (!file?.path) {
    return { status: "manual", message: "No file was uploaded." };
  }
  if (!isPlausibleImage(file)) {
    return {
      status: "manual",
      message:
        "The uploaded file does not look like a readable image. Review the document and enter the details manually.",
    };
  }

  try {
    const { text, confidence, lines } = await runOcr(file.path);
    if (!text || text.trim().length < 10) {
      return {
        status: "manual",
        message:
          "OCR could not read this document. Review the image and enter the details manually.",
      };
    }

    const { documentType, fields, warnings } = parseBillDocument(text, {
      lines,
      docConfidence: confidence,
    });
    const roundedConfidence = Math.round(confidence);
    const lowConfidence = roundedConfidence < LOW_CONFIDENCE_THRESHOLD || fields.items.length === 0;

    return {
      status: "extracted",
      message: lowConfidence
        ? "Couldn't reliably read this document. Review the extracted details and correct anything that looks wrong — or enter them manually."
        : "Text extracted from the document image. Review the values below, then save.",
      lowConfidence,
      documentType,
      fields,
      rawOcrText: text,
      confidence: roundedConfidence,
      warnings,
      extractedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error("[OCR] extraction failed:", err?.message ?? err);
    return {
      status: "manual",
      message: "OCR is unavailable right now. Review the image and enter the details manually.",
    };
  }
}
