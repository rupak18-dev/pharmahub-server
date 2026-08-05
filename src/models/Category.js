import { Schema, model } from "mongoose";

const categorySchema = new Schema(
  {
    name: { type: String, required: true, trim: true, unique: true, maxlength: 120 },
    description: { type: String, trim: true },
  },
  { timestamps: true },
);

export const Category = model("Category", categorySchema);
