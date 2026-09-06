// Server-side integration catalog. Names/descriptions here are authoritative
// (the API never trusts the client for display metadata). It mirrors the
// integrations the UI already represents in
// pharmahub-co/src/Pages/Admin/components/integrationsCatalog.jsx.
export const INTEGRATION_CATALOG = [
  {
    key: "whatsapp",
    name: "WhatsApp Business",
    description:
      "Connect your pharmacy's WhatsApp Business account to send customer bills directly through WhatsApp.",
  },
  {
    key: "gmail",
    name: "Gmail",
    description: "Send invoices, reports, and notifications from your pharmacy email.",
  },
  {
    key: "stripe",
    name: "Stripe",
    description: "Accept card payments for pharmacy transactions.",
  },
  {
    key: "razorpay",
    name: "Razorpay",
    description: "UPI and online payments for Indian pharmacy sales.",
  },
  {
    key: "zohoBooks",
    name: "Zoho Books",
    description: "Online accounting for pharmacy financial records.",
  },
  {
    key: "quickbooks",
    name: "QuickBooks",
    description: "Accounting and invoicing for pharmacy bookkeeping.",
  },
  {
    key: "gstFiling",
    name: "GST Filing",
    description: "Prepare and file pharmacy GST returns from your sales and purchase data.",
  },
  {
    key: "abdmHealthId",
    name: "ABDM Health ID",
    description: "Connect with the healthcare ecosystem to manage patient Health IDs.",
  },
  {
    key: "ePrescription",
    name: "E-Prescription Service",
    description: "Issue and manage digital prescriptions for pharmacy patients.",
  },
  {
    key: "medicineDelivery",
    name: "Delivery / Dispatch",
    description: "Local delivery partners for doorstep medicine orders.",
  },
  {
    key: "googleDrive",
    name: "Google Drive",
    description: "Back up invoices, reports, and pharmacy documents to cloud storage.",
  },
];

const CATALOG_MAP = new Map(INTEGRATION_CATALOG.map((item) => [item.key, item]));

export function findIntegrationMeta(key) {
  return CATALOG_MAP.get(key);
}
