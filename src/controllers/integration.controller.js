import { Integration } from "../models/Integration.js";

export async function listIntegrations(req, res, next) {
  try {
    const list = await Integration.find({ userId: req.user._id });
    const formatted = {};
    for (const item of list) {
      formatted[item.key] = {
        key: item.key,
        name: item.name,
        connected: item.connected,
        configured: item.configured,
        config: item.config,
        connectedAt: item.connectedAt,
        lastSync: item.lastSync,
      };
    }
    return res.json({ data: formatted });
  } catch (err) {
    return next(err);
  }
}

export async function connectIntegration(req, res, next) {
  try {
    const { key } = req.params;
    const { name, config } = req.body;
    let integration = await Integration.findOne({ key, userId: req.user._id });
    if (!integration) {
      integration = new Integration({
        key,
        name: name || key,
        userId: req.user._id,
      });
    }
    integration.connected = true;
    integration.configured = true;
    if (config) {
      integration.config = { ...(integration.config || {}), ...config };
    }
    integration.connectedAt = new Date();
    integration.lastSync = new Date();
    await integration.save();
    return res.json({ success: true, data: integration });
  } catch (err) {
    return next(err);
  }
}

export async function disconnectIntegration(req, res, next) {
  try {
    const { key } = req.params;
    const integration = await Integration.findOne({ key, userId: req.user._id });
    if (integration) {
      integration.connected = false;
      integration.configured = false;
      integration.config = {};
      integration.connectedAt = null;
      await integration.save();
    }
    return res.json({ success: true, message: "Integration disconnected" });
  } catch (err) {
    return next(err);
  }
}
