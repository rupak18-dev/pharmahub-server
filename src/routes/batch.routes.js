import { Router } from "express";

import { validate } from "../middlewares/validate.js";
import { auth } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { batchSchemas } from "../types/index.js";
import * as batchController from "../controllers/batch.controller.js";

const router = Router();

router.use(auth);

router.get("/", authorize("batches", "view"), batchController.listBatches);
router.get("/:id", authorize("batches", "view"), batchController.getBatch);
router.post(
  "/",
  authorize("batches", "create"),
  validate(batchSchemas.create),
  batchController.createBatch,
);
router.patch(
  "/:id",
  authorize("batches", "update"),
  validate(batchSchemas.update),
  batchController.updateBatch,
);
router.delete("/:id", authorize("batches", "delete"), batchController.deleteBatch);

export default router;
