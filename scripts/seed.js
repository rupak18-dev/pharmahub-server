import bcrypt from "bcryptjs";

import { connectDB, disconnectDB } from "../src/config/db.js";
import { Category } from "../src/models/Category.js";
import { Manufacturer } from "../src/models/Manufacturer.js";
import { Supplier } from "../src/models/Supplier.js";
import { Medicine } from "../src/models/Medicine.js";
import { Batch } from "../src/models/Batch.js";
import { InventoryItem } from "../src/models/InventoryItem.js";
import { User } from "../src/models/User.js";
import { Role } from "../src/models/Role.js";

function daysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

const categories = [
  { name: "Analgesics", description: "Pain relief medicines" },
  { name: "Antibiotics", description: "Antimicrobial medicines" },
  { name: "Cardiovascular", description: "Heart and blood pressure medicines" },
  { name: "Vitamins & Supplements", description: "Dietary supplements" },
  { name: "Gastro", description: "Gastrointestinal medicines" },
  { name: "Respiratory", description: "Breathing and asthma medicines" },
  { name: "Diabetic", description: "Diabetes management medicines" },
];

const manufacturers = [
  { name: "Cipla", contactInfo: "sales@cipla.example" },
  { name: "Sun Pharma", contactInfo: "sales@sunpharma.example" },
  { name: "GSK", contactInfo: "sales@gsk.example" },
  { name: "USV", contactInfo: "sales@usv.example" },
  { name: "Micro Labs", contactInfo: "sales@microlabs.example" },
  { name: "Zydus", contactInfo: "sales@zydus.example" },
  { name: "Alkem", contactInfo: "sales@alkem.example" },
];

const suppliers = [
  {
    name: "MedSupply Co.",
    contactInfo: "orders@medsupply.example",
    gstNumber: "27ABCDE1234F1Z5",
    paymentTerms: "Net 30",
  },
  {
    name: "HealthDist Ltd.",
    contactInfo: "orders@healthdist.example",
    gstNumber: "29PQRST9876G2Z9",
    paymentTerms: "Net 15",
  },
  {
    name: "CureWell Distributors",
    contactInfo: "orders@curewell.example",
    gstNumber: "24GHIJK5678H3X4",
    paymentTerms: "Net 30",
  },
];

const seedMedicines = [
  {
    name: "Paracetamol 500mg",
    genericName: "Paracetamol",
    brandName: "Crocin",
    categoryIndex: 0,
    manufacturerIndex: 0,
    prefix: "CR",
    reorderThreshold: 100,
    ptr: 15.5,
    gstRate: 12,
    rackLocation: "A-12",
    saltComposition: "Paracetamol IP 500mg",
    strength: "500 mg",
    dosageForm: "Tablet",
    packSize: "10 Tablets",
    gtin: "08901234567890",
    drugSchedule: "Schedule H",
  },
  {
    name: "Amoxicillin 250mg",
    genericName: "Amoxicillin",
    brandName: "Novamox",
    categoryIndex: 1,
    manufacturerIndex: 0,
    prefix: "NV",
    reorderThreshold: 80,
    ptr: 45.0,
    gstRate: 12,
    rackLocation: "B-03",
    saltComposition: "Amoxicillin Trihydrate IP 250mg",
    strength: "250 mg",
    dosageForm: "Capsule",
    packSize: "15 Capsules",
    gtin: "08901234567891",
    drugSchedule: "Schedule H1",
  },
  {
    name: "Azithromycin 500mg",
    genericName: "Azithromycin",
    brandName: "Azithral",
    categoryIndex: 1,
    manufacturerIndex: 1,
    prefix: "AZ",
    reorderThreshold: 50,
    ptr: 82.0,
    gstRate: 12,
    rackLocation: "B-05",
    saltComposition: "Azithromycin Dihydrate IP 500mg",
    strength: "500 mg",
    dosageForm: "Tablet",
    packSize: "5 Tablets",
    gtin: "08901234567892",
    drugSchedule: "Schedule H1",
  },
  {
    name: "Atorvastatin 10mg",
    genericName: "Atorvastatin",
    brandName: "Atorlip",
    categoryIndex: 2,
    manufacturerIndex: 1,
    prefix: "AT",
    reorderThreshold: 60,
    ptr: 32.5,
    gstRate: 12,
    rackLocation: "C-01",
    saltComposition: "Atorvastatin Calcium IP 10mg",
    strength: "10 mg",
    dosageForm: "Tablet",
    packSize: "15 Tablets",
    gtin: "08901234567893",
    drugSchedule: "Schedule H",
  },
  {
    name: "Metformin 500mg",
    genericName: "Metformin",
    brandName: "Glycomet",
    categoryIndex: 6,
    manufacturerIndex: 0,
    prefix: "GL",
    reorderThreshold: 90,
    ptr: 18.0,
    gstRate: 12,
    rackLocation: "C-04",
    saltComposition: "Metformin Hydrochloride IP 500mg",
    strength: "500 mg",
    dosageForm: "Tablet (SR)",
    packSize: "15 Tablets",
    gtin: "08901234567894",
    drugSchedule: "Schedule H",
  },
  {
    name: "Vitamin D3 60K IU",
    genericName: "Cholecalciferol",
    brandName: "Uprise-D3",
    categoryIndex: 3,
    manufacturerIndex: 2,
    prefix: "VD",
    reorderThreshold: 40,
    ptr: 78.0,
    gstRate: 12,
    rackLocation: "V-02",
    saltComposition: "Cholecalciferol 60,000 IU",
    strength: "60000 IU",
    dosageForm: "Softgel Capsule",
    packSize: "4 Capsules",
    gtin: "08901234567895",
    drugSchedule: "OTC / General Sales List",
  },
  {
    name: "Ibuprofen 400mg",
    genericName: "Ibuprofen",
    brandName: "Brufen",
    categoryIndex: 0,
    manufacturerIndex: 2,
    prefix: "BR",
    reorderThreshold: 75,
    ptr: 12.0,
    gstRate: 12,
    rackLocation: "A-15",
    saltComposition: "Ibuprofen IP 400mg",
    strength: "400 mg",
    dosageForm: "Tablet",
    packSize: "15 Tablets",
    gtin: "08901234567896",
    drugSchedule: "Schedule H",
  },
];

const stockPattern = [180, 96, 42, 210, 75, 160, 110];

async function run() {
  await connectDB();

  const force = process.argv.includes("--force");
  if (force) {
    const models = [User, Role, Category, Manufacturer, Supplier, Medicine, Batch, InventoryItem];
    for (const m of models) {
      await m.deleteMany({});
    }
    console.log("[seed] cleared existing data");
  }

  await Role.ensureSystemRoles();

  const catDocs = await Category.insertMany(categories);
  const mfrDocs = await Manufacturer.insertMany(manufacturers);
  const supDocs = await Supplier.insertMany(suppliers);
  const catMap = new Map(catDocs.map((c, i) => [i, c._id]));
  const mfrMap = new Map(mfrDocs.map((m, i) => [i, m._id]));

  const medDocs = [];
  for (const [i, m] of seedMedicines.entries()) {
    const med = await Medicine.create({
      ...m,
      categoryId: catMap.get(m.categoryIndex),
      manufacturerId: mfrMap.get(m.manufacturerIndex),
      barcode: `PH-${String(i + 1).padStart(8, "0")}`,
      maxStockLevel: 1000,
      storageRequirements: "Store below 25°C",
      isActive: true,
      hsnCode: "3004",
    });
    medDocs.push(med);
  }

  for (let i = 0; i < 43; i += 1) {
    const med = await Medicine.create({
      name: `Test Medicine ${i + 1} 500mg`,
      genericName: `Generic Alpha ${i + 1}`,
      brandName: `PharmaBrand ${i % 5}`,
      categoryId: catMap.get(i % 4),
      manufacturerId: mfrMap.get(i % 3),
      hsnCode: "3004",
      gstRate: 12,
      storageRequirements: "Store below 25°C",
      barcode: `PH-TEST-${i + 1}`,
      reorderThreshold: 50,
      isActive: true,
      prefix: "TM",
      saltComposition: `Active Ingredient ${i + 1}`,
      strength: "500 mg",
      dosageForm: i % 3 === 0 ? "Syrup" : "Tablet",
      packSize: "10 units",
      gtin: `08901234567${100 + i}`,
      drugSchedule: "Schedule H",
      maxStockLevel: 500,
      ptr: 15.0 + (i % 30),
      rackLocation: `R-${i % 10}`,
    });
    medDocs.push(med);
  }

  const locationPool = [
    "Front Shelf",
    "Front Shelf",
    "Backroom",
    "Cold Storage",
    "Front Shelf",
    "Backroom",
  ];
  const rackPool = [
    "Aisle A, Shelf 1",
    "Aisle A, Shelf 2",
    "Backroom Rack 1",
    "Cold Room 1",
    "Aisle B, Shelf 1",
    "Backroom Rack 2",
  ];

  let batchCount = 0;
  for (let i = 0; i < medDocs.length; i += 1) {
    const med = medDocs[i];
    const supplier = supDocs[i % 2]._id;
    const stockQty = stockPattern[i % stockPattern.length];

    const healthy = await Batch.create({
      medicineId: med._id,
      batchNumber: `${med.prefix}-${String(new Date().getFullYear()).slice(-2)}01-${String(i + 1).padStart(2, "0")}`,
      mfgDate: daysFromNow(-180),
      expiryDate: daysFromNow(365 + i * 20),
      mrp: 40 + i * 15,
      purchasePrice: 25 + i * 10,
      sellingPrice: 38 + i * 14,
      supplierId: supplier,
      currentStock: stockQty,
      status: "active",
    });
    batchCount += 1;

    const secondQty = Math.max(0, Math.round(stockQty / 3));
    const secondBatch = await Batch.create({
      medicineId: med._id,
      batchNumber: `${med.prefix}-${String(new Date().getFullYear()).slice(-2)}02-${String(i + 1).padStart(2, "0")}`,
      batchType: "C",
      dates: {
        manufacturingDate: daysFromNow(-300),
        expiryDate: daysFromNow(90),
        quarantineUntil: null,
      },
      pricing: {
        purchasePrice: 25 + i * 10,
        mrp: 40 + i * 15,
        sellingPrice: 38 + i * 14,
        gstRate: med.gstRate ?? 12,
      },
      status: { isRecalled: false, state: "ACTIVE", quarantineReason: null },
      stock: {
        uom: "Units",
        quantityOnHand: secondQty,
        reservedQuantity: 0,
        quarantined: 0,
      },
      warehouse: {
        locationType: locationPool[(i + 1) % locationPool.length],
        rackCode: rackPool[(i + 1) % rackPool.length],
      },
      supplierId: supDocs[(i + 1) % 2]._id,
      audit: { createdAt: new Date(), updatedAt: new Date(), updatedBy: "seed" },
      version: 1,
      movements: [
        {
          id: randomUUID(),
          type: "created",
          note: "Batch seeded",
          qty: secondQty,
          timestamp: new Date(),
          by: "seed",
        },
      ],
    });
    batchCount += 1;

    await InventoryItem.create({
      batchId: healthy._id,
      locationType: locationPool[i % locationPool.length],
      rackCode: rackPool[i % rackPool.length],
      quantityOnHand: stockQty,
      reservedQuantity: 0,
    });

    await InventoryItem.create({
      batchId: secondBatch._id,
      locationType: locationPool[(i + 1) % locationPool.length],
      rackCode: rackPool[(i + 1) % rackPool.length],
      quantityOnHand: secondQty,
      reservedQuantity: 0,
    });
  }

  console.log("[seed] done");
  console.log(`  categories   : ${catDocs.length}`);
  console.log(`  manufacturers: ${mfrDocs.length}`);
  console.log(`  suppliers    : ${supDocs.length}`);
  console.log(`  medicines    : ${medDocs.length}`);
  console.log(`  batches      : ${batchCount}`);
  console.log(`  users        : ${userCount} created`);
  console.log("");
  console.log("  Sign-in accounts (password: password123)");
  console.log("  owner@pharmahub.demo   | pharmacist@pharmahub.demo");
  console.log("  cashier@pharmahub.demo | inventory@pharmahub.demo");

  await disconnectDB();
}

run().catch((err) => {
  console.error("[seed] failed:", err);
  process.exit(1);
});
