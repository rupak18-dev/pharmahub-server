import mongoose from "mongoose";

import { ok } from "../core/responses.js";
import { constants } from "../config/constants.js";

export function health(_req, res) {
  const state = mongoose.connection.readyState;
  return ok(res, {
    service: constants.app.name,
    status: "ok",
    db: {
      connected: state === 1,
      state,
    },
    uptime: process.uptime(),
    time: new Date().toISOString(),
  });
}

export function info(_req, res) {
  return ok(res, {
    name: constants.app.name,
    version: constants.app.version,
    mode: process.env.NODE_ENV ?? "development",
    timestamp: new Date().toISOString(),
  });
}
