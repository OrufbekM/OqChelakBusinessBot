const express = require("express");
const router = express.Router();
const db = require("../models");
const {
  findFirstCourierWithinRadius,
  createCourierOrderRecord,
} = require("../controller/verification.controller");
const { notifySellerAboutOrder } = require("../controller/lib/telegram");

router.post("/new-order", async (req, res) => {
  try {
    const order = req.body.order || {}; 
    const customer = req.body.customer || order.customer || null; 

    if (!customer) {
      return res
        .status(400)
        .json({ ok: false, error: "Customer object is required in body.customer or body.order.customer" });
    }
    if (customer.latitude === undefined || customer.longitude === undefined) {
      return res
        .status(400)
        .json({ ok: false, error: "Customer latitude and longitude are required" });
    }

    const result = await findFirstCourierWithinRadius(db.User, customer, order);

    if (!result) {
      return res.status(404).json({ ok: false, error: "No courier found within radius" });
    }

    if (result?.courier?.chatId) {
      const prItem = order?.product?.items?.[0] || {};
      const productName = prItem.name || "Sut";
      const liters = prItem.quantity != null ? Number(prItem.quantity) : undefined;

      const customerChatId = customer.chatId || customer.telegramId || customer.id;
      const orderId = order.id != null ? String(order.id) : "";
      await notifySellerAboutOrder({
        sellerChatId: result.courier.chatId,
        customerChatId,
        orderId,
        productName,
        liters,
        latitude: customer.latitude,
        longitude: customer.longitude,
      });

      await createCourierOrderRecord({
        courierChatId: result.courier.chatId,
        customer,
        order,
        productName,
        liters,
        address: result.customerAddress,
      });
    }

    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

module.exports = router;

