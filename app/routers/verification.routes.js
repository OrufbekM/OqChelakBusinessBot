const express = require("express");
const router = express.Router();
const db = require("../models");
const {
  findFirstCourierWithinRadius,
  createCourierOrderRecord,
  rememberOrderAssignment,
  getOrderIdentifier,
} = require("../controller/verification.controller");
const { notifySellerAboutOrder } = require("../controller/lib/telegram");

router.post("/new-order", async (req, res) => {
  try {
    const order = req.body.order || {};
    const customer = req.body.customer || order.customer || null;

    if (!customer) {
      return res.status(400).json({
        ok: false,
        error:
          "Customer object is required in body.customer or body.order.customer",
      });
    }

    if (!customer.phone) {
      return res
        .status(400)
        .json({ ok: false, error: "Customer phone number is required" });
    }

    if (customer.latitude === undefined || customer.longitude === undefined) {
      return res.status(400).json({
        ok: false,
        error: "Customer latitude and longitude are required",
      });
    }

    const enrichedCustomer = {
      ...customer,
      userId:
        customer?.userId ??
        order?.userId ??
        order?.customerId ??
        customer?.id ??
        null,
    };

    const result = await findFirstCourierWithinRadius(
      db.User,
      enrichedCustomer,
      order
    );

    if (!result || !result?.candidates?.length) {
      return res
        .status(404)
        .json({ ok: false, error: "No courier found within radius" });
    }

    const prItem = order?.product?.items?.[0] || {};
    const productName = prItem.name || order?.product?.name || "Sut";
    const liters =
      prItem.quantity != null ? Number(prItem.quantity) : undefined;

    const customerChatId =
      enrichedCustomer.chatId ||
      enrichedCustomer.telegramId ||
      enrichedCustomer.id ||
      enrichedCustomer.userId;

    const normalizedOrderId = getOrderIdentifier(order, enrichedCustomer);

    const normalizedOrder = { ...order };
    if (normalizedOrder.id === undefined || normalizedOrder.id === null) {
      normalizedOrder.id = normalizedOrderId;
    }

    const activeCourier = result.courier;
    if (!activeCourier?.chatId) {
      return res
        .status(404)
        .json({ ok: false, error: "No courier chatId found" });
    }

    const initialIndex = result.candidates.findIndex(
      (candidate) => candidate?.courier?.chatId === activeCourier.chatId
    );

    rememberOrderAssignment(normalizedOrderId, {
      customer: enrichedCustomer,
      order: normalizedOrder,
      productName,
      liters,
      customerAddress: result.customerAddress,
      candidates: result.candidates,
      assignedIndex: initialIndex >= 0 ? initialIndex : 0,
      activeCourierChatId: activeCourier.chatId,
      phone: enrichedCustomer.phone,
    });

    await notifySellerAboutOrder({
      sellerChatId: activeCourier.chatId,
      customerChatId,
      orderId: normalizedOrderId,
      productName,
      liters,
      latitude: customer.latitude,
      longitude: customer.longitude,
    });

    async function createCourierOrderRecord({
      courierChatId,
      customer,
      order,
      productName,
      liters,
      address,
      phone,
    }) {
      return db.CourierOrder.create({
        courierChatId,
        customerChatId: customer.chatId || null,
        customerUserId: customer.userId || null,
        orderId: order.id,
        productName,
        liters,
        address,
        latitude: customer.latitude,
        longitude: customer.longitude,
        mapsUrl: address?.mapsUrl || null,
        phone, // ⭐ save phone
        customerName: customer.name || null,
        payload: order,
      });
    }

    res.json({ ok: true, orderId: normalizedOrderId, courier: activeCourier });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

module.exports = router;
