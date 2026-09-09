import { Router } from "express";

import { validate } from "../middlewares/validate.js";
import { auth } from "../middlewares/auth.js";
import { authorize } from "../middlewares/authorize.js";
import { uploadAvatar, runUpload } from "../middlewares/upload.js";
import { userSchemas } from "../types/index.js";
import * as userController from "../controllers/user.controller.js";

const router = Router();

// Public: an invitee is not yet a registered user, so acceptance and token
// validation must be reachable without a bearer token. Registered before the
// auth middleware below.
router.post(
  "/invitations/accept",
  validate(userSchemas.acceptInvitation),
  userController.acceptInvitation,
);
router.get("/invite/:token", userController.getInvitation);

router.use(auth);

router.get("/", authorize("users", "view"), userController.listUsers);
router.post(
  "/",
  authorize("users", "create"),
  validate(userSchemas.create),
  userController.createUser,
);

// "me" routes must be declared before /:id so Express never matches "me" as an id.
router.get("/me", userController.getMe);
router.put("/me/profile", validate(userSchemas.updateProfile), userController.updateMyProfile);
router.put("/me/avatar", runUpload(uploadAvatar), userController.updateAvatar);
router.delete("/me/avatar", userController.removeAvatar);

router.get("/invitations", authorize("users", "view"), userController.listInvitations);

// Must be before /:id routes to avoid Express matching "invite" as an ID.
router.post(
  "/invite",
  authorize("users", "create"),
  validate(userSchemas.invite),
  userController.inviteUser,
);
router.get("/invite/:id/link", authorize("users", "create"), userController.getInvitationLink);
router.post("/invite/:id/resend", authorize("users", "create"), userController.resendInvitation);
router.delete("/invite/:id", authorize("users", "create"), userController.cancelInvitation);

router.get("/:id", authorize("users", "view"), userController.getUser);
router.patch(
  "/:id",
  authorize("users", "update"),
  validate(userSchemas.update),
  userController.updateUser,
);
router.delete("/:id", authorize("users", "delete"), userController.deleteUser);

export default router;
