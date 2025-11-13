const express = require("express");
const router = express.Router();
const db = require("../models");
const { findFirstCourierWithinRadius } = require("../controller/verification.controller");

router.post("/new-order", async (req, res) => {
  try {
    const { latitude, longitude } = req.body || {};
    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({ ok: false, error: "latitude and longitude are required" });
    }

    const customer = { latitude, longitude };
    const result = await findFirstCourierWithinRadius(db.User, customer);

    if (!result) {
      return res.status(404).json({ ok: false, error: "No courier found within radius" });
    }

    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

module.exports = router;

