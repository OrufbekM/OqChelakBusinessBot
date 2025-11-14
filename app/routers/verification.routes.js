const express = require("express");
const router = express.Router();
const db = require("../models");
const { findFirstCourierWithinRadius } = require("../controller/verification.controller");

router.post("/new-order", async (req, res) => {
  try {
    const customer = req.body.customer; 
    const order = req.body.order || {}; 

    if (!customer || customer.latitude === undefined || customer.longitude === undefined) {
      return res.status(400).json({ ok: false, error: "Customer latitude and longitude are required" });
    }

    const result = await findFirstCourierWithinRadius(db.User, customer, order);

    if (!result) {
      return res.status(404).json({ ok: false, error: "No courier found within radius" });
    }

    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

module.exports = router;
