import { Router } from "express";
import { auth } from "../middlewares/auth.js";
<<<<<<< HEAD
import { ok } from "../core/responses.js";

const router = Router();

router.get("/", auth, (req, res) => {
  return ok(res, {}, "Onboarding data");
});

router.put("/", auth, (req, res) => {
  return ok(res, req.body, "Onboarding data saved");
});
=======
import { get, save } from "../controllers/onboarding.controller.js";

// All onboarding persistence flows through the controller so completion-time
// side effects (role adoption, onboarded flag) always run.
const router = Router();

router.get("/", auth, get);
router.put("/", auth, save);
>>>>>>> c876e587860aeb70c959d2e9fa3874741ecda6d3

export default router;
