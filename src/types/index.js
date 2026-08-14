import { z } from "zod";

import { constants } from "../config/constants.js";

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
 * @property {import("mongoose").Types.ObjectId} [supplierId]
 * @property {string} batchNumber
 * @property {"C"|"L"|"V"} [batchType]
 * @property {object} dates
 * @property {Date} dates.manufacturingDate
 * @property {Date} dates.expiryDate
 * @property {Date|null} [dates.quarantineUntil]
 * @property {object} pricing
 * @property {number} pricing.purchasePrice
 * @property {number} pricing.mrp
 * @property {number} pricing.sellingPrice
 * @property {number} pricing.gstRate
 * @property {object} status
 * @property {boolean} status.isRecalled
 * @property {"ACTIVE"|"QUARANTINED"|"RECALLED"|"BLOCKED"|"RETIRED"} status.state
 * @property {string|null} [status.quarantineReason]
 * @property {object} stock
 * @property {string} stock.uom
 * @property {number} stock.quantityOnHand
 * @property {number} stock.reservedQuantity
 * @property {number} stock.quarantined
 * @property {object} warehouse
 * @property {string} warehouse.locationType
 * @property {string} warehouse.rackCode
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
const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128)
  .regex(/[A-Z]/, "Password must include an uppercase letter")
  .regex(/[a-z]/, "Password must include a lowercase letter")
  .regex(/[0-9]/, "Password must include a number")
  .regex(/[^A-Za-z0-9]/, "Password must include a special character");

export const authSchemas = {
  register: z.object({
    name: z.string().trim().max(120).optional(),
    email: emailSchema,
    password: passwordSchema,
    role: z.string().trim().optional(),
    orgName: z.string().trim().optional(),
  }),
  login: z.object({
    email: emailSchema,
    password: z.string().min(1, "Password is required"),
  }),
  profile: z.object({
    name: z.string().trim().min(1, "Name is required").max(120).optional(),
    role: z.string().trim().min(1, "Role is required").optional(),
    orgName: z.string().trim().max(120).optional(),
    onboarded: z.boolean().optional(),
  }),
  changePassword: z.object({
    currentPassword: z.string().min(1),
    newPassword: passwordSchema,
  }),
};

export const onboardingSchemas = {
  upsert: z.object({
    businessType: z.enum(["retail", "dealer", "enterprise", "hospital", "other"]).optional(),
    personal: z
      .object({
        firstName: z.string().trim().max(80).optional(),
        lastName: z.string().trim().max(80).optional(),
        phone: z.string().trim().max(20).optional(),
        jobTitle: z.string().trim().max(120).optional(),
      })
      .optional(),
    workspace: z
      .object({
        organizationName: z.string().trim().max(120).optional(),
        branchName: z.string().trim().max(120).optional(),
        drugLicenseNumber: z.string().trim().max(80).optional(),
        gstNumber: z.string().trim().max(80).optional(),
      })
      .optional(),
    quickStart: z.array(z.string()).optional(),
    currentStep: z.number().int().min(0).optional(),
    completedAt: z.string().datetime().nullable().optional(),
  }),
};

export const userSchemas = {
  create: z.object({
    name: z.string().trim().min(1).max(120),
    email: emailSchema,
    password: passwordSchema,
    role: z.string().trim().min(1),
    orgName: z.string().trim().optional(),
  }),
  update: z
    .object({
      name: z.string().trim().min(1).max(120).optional(),
      role: z.string().trim().min(1).optional(),
      active: z.boolean().optional(),
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

const BATCH_STATES = ["ACTIVE", "QUARANTINED", "RECALLED", "BLOCKED", "RETIRED"];
const BATCH_LOCATIONS = constants.locationTypes;

const batchUpdateFields = {
  medicineId: idsSchema(),
  supplierId: z.string().nullable().optional(),
  batchNumber: z.string().trim().min(1).max(40).optional(),
  batchType: z.enum(["C", "L", "V"]).optional(),
  dates: z
    .object({
      manufacturingDate: z.coerce.date().optional(),
      expiryDate: z.coerce.date().optional(),
      quarantineUntil: z.coerce.date().nullable().optional(),
    })
    .optional(),
  pricing: z
    .object({
      purchasePrice: z.coerce.number().min(0).optional(),
      mrp: z.coerce.number().min(0).optional(),
      sellingPrice: z.coerce.number().min(0).optional(),
      gstRate: z.coerce.number().min(0).optional(),
    })
    .optional(),
  status: z
    .object({
      isRecalled: z.boolean().optional(),
      state: z.enum(BATCH_STATES).optional(),
      quarantineReason: z.string().nullable().optional(),
    })
    .optional(),
  stock: z
    .object({
      uom: z.string().optional(),
      quantityOnHand: z.coerce.number().int().min(0).optional(),
      reservedQuantity: z.coerce.number().int().min(0).optional(),
      quarantined: z.coerce.number().int().min(0).optional(),
    })
    .optional(),
  warehouse: z
    .object({
      locationType: z.enum(BATCH_LOCATIONS).optional(),
      rackCode: z.string().trim().max(40).optional(),
    })
    .optional(),
};

export const batchActions = ["quarantine", "activate", "recall", "block", "retire"];

const batchActionSchema = z.object({
  action: z.enum(batchActions),
  reason: z.string().trim().max(300).optional(),
});

export const batchSchemas = {
  create: z.object({
    medicineId: objectId(),
    supplierId: z.string().nullable().optional(),
    batchNumber: z.string().trim().min(1).max(40),
    batchType: z.enum(["C", "L", "V"]).default("C"),
    dates: z.object({
      manufacturingDate: z.coerce.date(),
      expiryDate: z.coerce.date(),
      quarantineUntil: z.coerce.date().nullable().optional(),
    }),
    pricing: z
      .object({
        purchasePrice: z.coerce.number().min(0).default(0),
        mrp: z.coerce.number().min(0).default(0),
        sellingPrice: z.coerce.number().min(0).default(0),
        gstRate: z.coerce.number().min(0).default(0),
      })
      .optional(),
    status: z
      .object({
        isRecalled: z.boolean().optional().default(false),
        state: z.enum(BATCH_STATES).optional().default("ACTIVE"),
        quarantineReason: z.string().nullable().optional().default(null),
      })
      .optional(),
    stock: z
      .object({
        uom: z.string().optional().default("Units"),
        quantityOnHand: z.coerce.number().int().min(0).default(0),
        reservedQuantity: z.coerce.number().int().min(0).default(0),
        quarantined: z.coerce.number().int().min(0).default(0),
      })
      .optional(),
    warehouse: z.object({
      locationType: z.enum(BATCH_LOCATIONS),
      rackCode: z.string().trim().max(40).default(""),
    }),
  }),
  update: z.object(batchUpdateFields),
  action: batchActionSchema,
  patch: z.union([
    batchActionSchema,
    z.object(batchUpdateFields).refine((v) => Object.keys(v).length > 0, "At least one field is required"),
  ]),
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
    quantityChange: z.coerce.number().int().refine((v) => v !== 0, "Cannot be zero"),
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
