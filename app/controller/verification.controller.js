const haversine = require("haversine-distance");
const {
  reverseGeocode,
  reverseGeocodeDetailed,
  formatUzAddress,
} = require("../utils/geocode");
const db = require("../models");

function toNumber(value) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeRadius(radiusInMeters) {
  if (radiusInMeters === null) return Infinity;
  const radius = toNumber(radiusInMeters);
  if (radius === null || radius < 0) return null;
  return radius;
}

function buildCoordinate(entity) {
  const lat = toNumber(entity?.latitude);
  const lon = toNumber(entity?.longitude);
  if (lat === null || lon === null) return null;
  return [lat, lon];
}

function formatCoordinates([lat, lon]) {
  return `lat ${lat}, lon ${lon}`;
}

async function resolveAddress(lat, lon) {
  const detailed = await reverseGeocodeDetailed(lat, lon);
  if (detailed && detailed.address) {
    const formatted = formatUzAddress(detailed.address);
    if (formatted) return formatted;
  }
  const fallback = await reverseGeocode(lat, lon);
  if (fallback) return fallback;
  return `${lat}, ${lon}`;
}

/**
 * Find first courier within radius for a given customer (from another bot)
 * @param {Object} User - Courier model (db.User)
 * @param {Object} customer - { id, chatId, username, fullName, latitude, longitude }
 * @param {Object} order - optional order info { id, items, ... }
 * @returns {Promise<null|Object>} - returns courier, distance, customer info, order info
 */
async function findFirstCourierWithinRadius(User, customer, order = {}) {
  if (!customer) return null;

  const CourierModel = User ?? db?.User ?? db;
  if (!CourierModel || typeof CourierModel.findAll !== "function") return null;

  const couriers = await CourierModel.findAll();
  if (!Array.isArray(couriers) || couriers.length === 0) return null;

  const customerCoords = buildCoordinate(customer);
  if (!customerCoords) return null;

  for (const courierRecord of couriers) {
    const courier =
      typeof courierRecord?.get === "function"
        ? courierRecord.get({ plain: true })
        : courierRecord?.dataValues
        ? courierRecord.dataValues
        : courierRecord;

    const courierCoords = buildCoordinate(courier);
    if (!courierCoords) continue;

    const courierRadius = normalizeRadius(courier?.deliveryRadius);
    if (courierRadius === null) continue;

    const distance = haversine(courierCoords, customerCoords);
    if (distance > courierRadius) continue;

    const customerAddress =
      (await resolveAddress(customerCoords[0], customerCoords[1])) ||
      formatCoordinates(customerCoords);

    const distanceKm = Number((distance / 1000).toFixed(2));

    console.log(
      [
        "Zakaz keldi! 🛒",
        `Buyurtma bergan: ${customer.fullName || customer.username}`,
        `Manzil: ${customerAddress}`,
        `Masofa: ${distanceKm} km`,
      ].join("\n")
    );

    return {
      order,
      customer,
      courier: {
        id: courier?.id,
        latitude: courierCoords[0],
        longitude: courierCoords[1],
        deliveryRadius: courierRadius,
      },
      distanceKm,
      customerAddress,
    };
  }

  return null;
}

async function getProducts(req, res) {
  try {
    const { chatId, limit, offset } = req.query;

    const where = {};
    if (chatId) {
      where.chatId = BigInt(chatId);
    }

    const options = {
      where,
      order: [["createdAt", "DESC"]],
    };

    if (limit) {
      options.limit = parseInt(limit, 10);
    }
    if (offset) {
      options.offset = parseInt(offset, 10);
    }

    const products = await db.Product.findAll(options);
    const total = await db.Product.count({ where });

    const formattedProducts = products.map((product) => ({
      id: product.id,
      productName: product.productName || "Sut",
      productPrice: product.productPrice,
      productSize: product.productSize,
      chatId: product.chatId.toString(),
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
    }));

    res.json({
      ok: true,
      products: formattedProducts,
      total,
      limit: options.limit || null,
      offset: options.offset || 0,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message || String(e),
    });
  }
}

module.exports = {
  findFirstCourierWithinRadius,
  getProducts,
};
