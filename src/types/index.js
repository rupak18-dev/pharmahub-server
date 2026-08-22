import { z } from "zod";

import { normalizeIndianPhone } from "../utils/phone.js";

/**
 * @typedef {import("mongoose").Document} MongooseDocument
 *
 * @typedef {object} IUser
 * @property {string} name
 * @property {string} email
 * @property {string} passwordHash
 * @property {string} role
 * @property {boolean} active
 * @property {string} orgName
 *
 * @typedef {object} IMedicine
 * @property {string} name
 * @property {string} genericName
 * @property {string} brandName
 * @property {import("mongoose").Types.ObjectId} categoryId
 * @property {import("mongoose").Types.ObjectId} manufacturerId
 * @property {number} gstRate
 * @property {number} reorderThreshold
 * @property {string} [prefix]
 * @property {number} ptr
 * @property {number} maxStockLevel
 *
 * @typedef {object} IBatch
 * @property {import("mongoose").Types.ObjectId} medicineId
 * @property {string} batchNumber
 * @property {Date} mfgDate
 * @property {Date} expiryDate
 * @property {number} mrp
 * @property {number} purchasePrice
 * @property {number} sellingPrice
 * @property {import("mongoose").Types.ObjectId} [supplierId]
 * @property {number} currentStock
 * @property {string} status
 *
 * @typedef {object} ISaleItem
 * @property {import("mongoose").Types.ObjectId} medicineId
 * @property {import("mongoose").Types.ObjectId} batchId
 * @property {string} medicineName
 * @property {string} batchNumber
 * @property {number} quantity
 * @property {number} unitPrice
 * @property {number} discountPct
 * @property {number} gstRate
 * @property {number} lineTotal
 *
 * @typedef {object} ISale
 * @property {string} invoiceNo
 * @property {string} [customerName]
 * @property {string} [customerPhone]
 * @property {ISaleItem[]} items
 * @property {number} subtotal
 * @property {number} discountTotal
 * @property {number} gstTotal
 * @property {number} roundOff
 * @property {number} grandTotal
 * @property {string} paymentMode
 * @property {number} [tender]
 * @property {number} [change]
 * @property {string} status
 *
 * @typedef {object} IPurchaseItem
 * @property {import("mongoose").Types.ObjectId} medicineId
 * @property {import("mongoose").Types.ObjectId} [batchId]
 * @property {string} medicineName
 * @property {number} quantity
 * @property {number} unitCost
 * @property {number} gstRate
 * @property {number} lineTotal
 *
 * @typedef {object} IPurchase
 * @property {string} orderNo
 * @property {import("mongoose").Types.ObjectId} supplierId
 * @property {IPurchaseItem[]} items
 * @property {number} subtotal
 * @property {number} gstTotal
 * @property {number} grandTotal
 * @property {string} status
 * @property {Date} [orderedAt]
 * @property {Date} [receivedAt]
 */

export const objectId = () => z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid ObjectId");

const idsSchema = () =>
  z
    .string()
    .optional()
    .refine((v) => !v || /^[0-9a-fA-F]{24}$/.test(v), "Invalid ObjectId");

const emailSchema = z.string().trim().email("Invalid email").max(160);
const passwordSchema = z.string().min(6, "Password must be at least 6 characters").max(128);

// Optional Indian mobile number: accepts "+91 98765 43210", "98765 43210" or
// "+919876543210" and normalizes to "+919876543210". Empty/absent is allowed.
const phoneSchema = z
  .string()
  .trim()
  .max(20, "Phone number is too long")
  .optional()
  .refine(
    (v) => !v || /^(?:\+91)?[6-9]\d{9}$/.test(v.replace(/[\s\-().]/g, "")),
    "Enter a valid Indian mobile number (10 digits starting with 6–9, e.g. +91 98765 43210)",
  )
  .transform((v) => (v ? normalizeIndianPhone(v) : v));

// Lenient phone schema for PATCH updates: accepts any non-empty string up to
// 20 chars without enforcing Indian format. This prevents stored phones in
// non-Indian formats from blocking unrelated field updates.
const updatePhoneSchema = z.string().trim().max(20, "Phone number is too long").optional();

export const authSchemas = {
  register: z.object({
    name: z.string().trim().min(1, "Name is required").max(120),
    email: emailSchema,
    password: passwordSchema,
    orgName: z.string().trim().optional(),
  }),
  login: z.object({
    email: emailSchema,
    password: z.string().min(1, "Password is required"),
    remember: z.boolean().optional(),
  }),
  forgotPassword: z.object({
    email: emailSchema,
  }),
  resetPassword: z.object({
    email: emailSchema,
    code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from your email"),
    newPassword: passwordSchema,
  }),
  profile: z.object({
    name: z.string().trim().min(1, "Name is required").max(120).optional(),
    role: z.enum(["Owner", "Admin", "Pharmacist", "Cashier", "Store Keeper", "Inventory Manager"]).optional(),
    orgName: z.string().trim().max(120).optional(),
    onboarded: z.boolean().optional(),
  }),
  changePassword: z.object({
    currentPassword: z.string().min(1),
    newPassword: passwordSchema,
  }),
  forgotPassword: z.object({
    email: emailSchema,
  }),
  resetPassword: z.object({
    token: z.string().trim().min(1),
    newPassword: passwordSchema,
  }),
  demoLogin: z.object({
    email: emailSchema,
  }),
};

export const userSchemas = {
  create: z.object({
    name: z.string().trim().min(1).max(120),
    email: emailSchema,
    password: passwordSchema,
    role: z.string().trim().min(1),
    orgName: z.string().trim().optional(),
    phone: phoneSchema,
  }),
  update: z
    .object({
      name: z.string().trim().min(1).max(120).optional(),
      role: z.string().trim().min(1).optional(),
      active: z.boolean().optional(),
      status: z.enum(["active", "suspended", "inactive"]).optional(),
      phone: updatePhoneSchema,
      email: emailSchema.optional(),
      permissions: z.record(z.string(), z.record(z.string(), z.boolean())).optional(),
      featureAccess: z.record(z.string(), z.boolean()).optional(),
      accessIds: z.array(z.string().trim().min(1).max(80)).optional(),
      department: z.string().trim().max(120).optional(),
      designation: z.string().trim().max(120).optional(),
    })
    .refine((v) => Object.keys(v).length > 0, "At least one field is required"),
  invite: z.object({
    name: z.string().trim().max(120).optional(),
    email: emailSchema,
    role: z.string().trim().min(1),
    phone: phoneSchema,
    department: z.string().trim().max(120).optional(),
    message: z.string().trim().max(500).optional(),
    // Per-user permission overrides (module -> action flags). Any shape that
    // passes through is re-sanitized server-side against the canonical module
    // and action lists, so a loose schema here is acceptable.
    permissions: z.record(z.string(), z.record(z.string(), z.boolean())).optional(),
    featureAccess: z.record(z.string(), z.boolean()).optional(),
    accessIds: z.array(z.string().trim().min(1).max(80)).optional(),
  }),
  acceptInvitation: z.object({
    token: z.string().trim().min(1),
    name: z.string().trim().max(120).optional(),
    password: passwordSchema,
    phone: phoneSchema,
  }),
  updateProfile: z
    .object({
      name: z.string().trim().min(1).max(120).optional(),
      email: emailSchema.optional(),
      phone: phoneSchema,
      orgName: z.string().trim().max(120).optional(),
      tagline: z.string().trim().max(200).optional(),
      description: z.string().trim().max(2000).optional(),
      businessEmail: emailSchema.optional(),
      website: z.string().trim().max(200).optional(),
      address: z.string().trim().max(500).optional(),
      city: z.string().trim().max(100).optional(),
      state: z.string().trim().max(100).optional(),
      pincode: z.string().trim().max(20).optional(),
      gstin: z.string().trim().max(30).optional(),
      licenseNo: z.string().trim().max(50).optional(),
      businessType: z.string().trim().max(100).optional(),
      services: z.string().trim().max(1000).optional(),
      businessHours: z.string().trim().max(500).optional(),
      metaPixelId: z.string().trim().max(200).optional(),
      branches: z.array(z.string().trim().max(200)).max(20).optional(),
    })
    .refine((v) => Object.keys(v).length > 0, "At least one field is required"),
};

const medicineCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  genericName: z.string().trim().optional(),
  brandName: z.string().trim().optional(),
  categoryId: idsSchema(),
  manufacturerId: idsSchema(),
  hsnCode: z.string().trim().max(20).optional(),
  gstRate: z.coerce.number().min(0).max(100).default(0),
  storageRequirements: z.string().trim().optional(),
  barcode: z.string().trim().max(60).optional(),
  reorderThreshold: z.coerce.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
  prefix: z.string().trim().max(10).optional(),
  saltComposition: z.string().trim().optional(),
  strength: z.string().trim().max(40).optional(),
  dosageForm: z.string().trim().max(40).optional(),
  packSize: z.string().trim().max(40).optional(),
  gtin: z.string().trim().max(40).optional(),
  drugSchedule: z.string().trim().max(40).optional(),
  dosageInfo: z.string().trim().optional(),
  usageInstructions: z.string().trim().optional(),
  contraindications: z.string().trim().optional(),
  sideEffects: z.string().trim().optional(),
  maxStockLevel: z.coerce.number().int().min(0).optional(),
  ptr: z.coerce.number().min(0).optional(),
  rackLocation: z.string().trim().max(40).optional(),
});
export const medicineSchemas = {
  create: medicineCreateSchema,
  update: medicineCreateSchema.partial(),
};

export const batchSchemas = {
  create: z.object({
    medicineId: objectId(),
    batchNumber: z.string().trim().min(1).max(40),
    mfgDate: z.coerce.date(),
    expiryDate: z.coerce.date(),
    mrp: z.coerce.number().min(0).optional(),
    purchasePrice: z.coerce.number().min(0).optional(),
    sellingPrice: z.coerce.number().min(0).optional(),
    supplierId: idsSchema(),
    currentStock: z.coerce.number().int().min(0).default(0),
    status: z.string().trim().optional(),
    locationType: z.string().trim().optional(),
    rackCode: z.string().trim().max(40).optional(),
    quantityReceived: z.coerce.number().int().min(0).optional(),
  }),
  update: z.object({
    batchNumber: z.string().trim().min(1).max(40).optional(),
    mfgDate: z.coerce.date().optional(),
    expiryDate: z.coerce.date().optional(),
    mrp: z.coerce.number().min(0).optional(),
    purchasePrice: z.coerce.number().min(0).optional(),
    sellingPrice: z.coerce.number().min(0).optional(),
    supplierId: idsSchema(),
    status: z.string().trim().optional(),
    locationType: z.string().trim().optional(),
    rackCode: z.string().trim().max(40).optional(),
  }),
};

const categoryCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().optional(),
});
export const categorySchemas = {
  create: categoryCreateSchema,
  update: categoryCreateSchema.partial(),
};

const manufacturerCreateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  contactInfo: z.string().trim().optional(),
  address: z.string().trim().optional(),
});
export const manufacturerSchemas = {
  create: manufacturerCreateSchema,
  update: manufacturerCreateSchema.partial(),
};

const supplierCreateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  contactInfo: z.string().trim().optional(),
  gstNumber: z.string().trim().max(40).optional(),
  paymentTerms: z.string().trim().max(80).optional(),
  address: z.string().trim().optional(),
  phone: z.string().trim().max(30).optional(),
  email: z.string().trim().email().optional().or(z.literal("")),
});
export const supplierSchemas = {
  create: supplierCreateSchema,
  update: supplierCreateSchema.partial(),
};

export const inventorySchemas = {
  addStock: z.object({
    batchId: objectId(),
    locationType: z.string().trim().min(1),
    rackCode: z.string().trim().min(1).max(40),
    quantity: z.coerce.number().int().positive("Quantity must be positive"),
    referenceDocId: idsSchema(),
  }),
  adjustStock: z.object({
    batchId: objectId(),
    locationType: z.string().trim().optional(),
    rackCode: z.string().trim().optional(),
    newQuantity: z.coerce.number().int().min(0),
    reason: z.string().trim().optional(),
  }),
  movement: z.object({
    movementType: z.string().trim().min(1),
    quantityChange: z.coerce
      .number()
      .int()
      .refine((v) => v !== 0, "Cannot be zero"),
    batchId: objectId(),
    locationType: z.string().trim().optional(),
    rackCode: z.string().trim().optional(),
    referenceDocId: idsSchema(),
    note: z.string().trim().optional(),
  }),
};

export const purchaseSchemas = {
  create: z.object({
    supplierId: objectId(),
    items: z
      .array(
        z.object({
          medicineId: objectId(),
          quantity: z.coerce.number().int().positive(),
          unitCost: z.coerce.number().min(0),
          gstRate: z.coerce.number().min(0).max(100).default(0),
        }),
      )
      .min(1, "At least one item is required"),
    discount: z.coerce.number().min(0).default(0),
    notes: z.string().trim().optional(),
    batchNumbers: z.record(z.string(), z.string()).optional(),
  }),
  receive: z.object({
    items: z
      .array(
        z.object({
          itemId: objectId(),
          quantityReceived: z.coerce.number().int().positive(),
          batchNumber: z.string().trim().optional(),
          mfgDate: z.coerce.date().optional(),
          expiryDate: z.coerce.date().optional(),
          mrp: z.coerce.number().min(0).optional(),
          sellingPrice: z.coerce.number().min(0).optional(),
          locationType: z.string().trim().optional(),
          rackCode: z.string().trim().optional(),
        }),
      )
      .min(1),
  }),
  updateStatus: z.object({
    status: z.enum(["draft", "ordered", "received", "partially_received", "cancelled"]),
  }),
};

export const saleSchemas = {
  create: z.object({
    customerName: z.string().trim().optional(),
    customerPhone: z.string().trim().max(30).optional(),
    items: z
      .array(
        z.object({
          medicineId: objectId(),
          quantity: z.coerce.number().int().positive(),
          discountPct: z.coerce.number().min(0).max(100).default(0),
        }),
      )
      .min(1, "Cart cannot be empty"),
    paymentMode: z.string().trim().min(1).default("Cash"),
    tender: z.coerce.number().min(0).optional(),
  }),
  void: z.object({
    reason: z.string().trim().min(1, "Reason is required").max(300),
  }),
};

export const notificationSchemas = {
  markRead: z.object({
    ids: z.array(z.string()).min(1),
  }),
};

export const auditSchemas = {
  create: z.object({
    action: z.string().trim().min(1),
    entityType: z.string().trim().optional(),
    entityId: z.string().trim().optional(),
    details: z.record(z.any()).optional(),
  }),
};

// Integration config values are plain, non-secret strings (phone numbers,
// org ids, etc.). Secret/credential fields are rejected at write time by the
// integration service, never persisted.
const integrationConfigSchema = z.record(
  z.string().trim().max(120),
  z.string().max(2000, "Config values must be 2000 characters or fewer"),
);

export const integrationSchemas = {
  connect: z.object({
    name: z.string().trim().max(120).optional(),
    config: integrationConfigSchema.optional(),
  }),
  configure: z.object({
    config: integrationConfigSchema.optional(),
  }),
};
