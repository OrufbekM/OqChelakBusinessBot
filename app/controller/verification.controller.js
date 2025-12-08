const haversine = require("haversine-distance");
const {
  reverseGeocode,
  reverseGeocodeDetailed,
  formatUzAddress,
} = require("../utils/geocode");
const db = require("../models");

const orderAssignments = new Map();

function getOrderIdentifier(order = {}, customer = {}) {
  // Prefer stable external order identifiers coming from the request payload
  // instead of database-generated ids that may change.
  const directCandidates = [
    order?.orderId,
    order?.externalId,
    order?.payload?.orderId,
    order?.payload?.order?.orderId,
    order?.id,
    order?.payload?.order?.id,
  ];
  for (const candidate of directCandidates) {
    if (candidate !== undefined && candidate !== null && candidate !== "") {
      return String(candidate);
    }
  }
  const customerKey =
    customer?.chatId || customer?.telegramId || customer?.id || "anon";
  return `tmp-${customerKey}-${Date.now()}`;
}

function normalizeCandidateList(candidates = []) {
  return candidates
    .filter(Boolean)
    .map((candidate) => ({
      courier: candidate.courier,
      distanceMeters: candidate.distanceMeters,
      distanceKm: candidate.distanceKm,
      withinRadius: Boolean(candidate.withinRadius),
    }));
}

function rememberOrderAssignment(orderId, payload = {}) {
  if (!orderId) return;
  const snapshot = {
    ...payload,
    candidates: normalizeCandidateList(payload.candidates),
    assignedIndex:
      typeof payload.assignedIndex === "number" ? payload.assignedIndex : 0,
    activeCourierChatId:
      payload.activeCourierChatId ||
      payload.candidates?.[payload.assignedIndex || 0]?.courier?.chatId ||
      null,
    declinedChatIds:
      payload.declinedChatIds instanceof Set
        ? payload.declinedChatIds
        : new Set(payload.declinedChatIds || []),
  };
  orderAssignments.set(orderId, snapshot);
}

function getNextCourierForOrder(orderId, declinedChatId = null) {
  const state = orderAssignments.get(orderId);
  if (!state) {
    return null;
  }

  if (declinedChatId) {
    state.declinedChatIds.add(declinedChatId);
    if (state.activeCourierChatId === declinedChatId) {
      state.activeCourierChatId = null;
    }
  }

  let nextIndex = (state.assignedIndex ?? -1) + 1;
  while (nextIndex < state.candidates.length) {
    const candidate = state.candidates[nextIndex];
    const candidateChatId = candidate?.courier?.chatId;
    if (!candidateChatId || state.declinedChatIds.has(candidateChatId)) {
      nextIndex += 1;
      continue;
    }
    state.assignedIndex = nextIndex;
    state.activeCourierChatId = candidateChatId;
    return {
      candidate,
      context: state,
    };
  }

  orderAssignments.delete(orderId);
  return null;
}

function clearOrderAssignment(orderId) {
  if (orderId) {
    orderAssignments.delete(orderId);
  }
}

function getOrderAssignment(orderId) {
  if (!orderId) return null;
  return orderAssignments.get(orderId) || null;
}

function markOrderAccepted(orderId, courierChatId) {
  if (!orderId) return;
  const state = orderAssignments.get(orderId);
  if (!state) return;
  state.acceptedBy = courierChatId || state.acceptedBy || null;
  state.activeCourierChatId = courierChatId || state.activeCourierChatId || null;
  orderAssignments.set(orderId, state);
}

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

  const candidates = [];

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
    const withinRadius = distance <= courierRadius;

    candidates.push({
      courier: {
        id: courier?.id,
        chatId: courier?.chatId,
        latitude: courierCoords[0],
        longitude: courierCoords[1],
        deliveryRadius: courierRadius,
      },
      distanceMeters: distance,
      distanceKm: Number((distance / 1000).toFixed(2)),
      withinRadius,
    });
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => {
    if (a.withinRadius !== b.withinRadius) {
      return a.withinRadius ? -1 : 1;
    }
    return a.distanceMeters - b.distanceMeters;
  });

  const topCandidate = candidates[0];

  const customerAddress =
    (await resolveAddress(customerCoords[0], customerCoords[1])) ||
    formatCoordinates(customerCoords);

  console.log(
    [
      "Zakaz keldi! 🛒",
      `Buyurtma bergan: ${customer.fullName || customer.username || "Nomalum"}`,
      `Manzil: ${customerAddress}`,
      `Masofa: ${topCandidate.distanceKm} km`,
    ].join("\n")
  );

  return {
    order,
    customer,
    courier: topCandidate.courier,
    distanceKm: topCandidate.distanceKm,
    customerAddress,
    candidates,
  };
}

async function createCourierOrderRecord({
  courierChatId,
  customer = {},
  order = {},
  productName,
  liters,
  address,
}) {
  try {
    const CourierOrderModel = db?.CourierOrder;
    if (!CourierOrderModel || !courierChatId) {
      return null;
    }

    const lat = toNumber(customer?.latitude);
    const lon = toNumber(customer?.longitude);
    let resolvedAddress = address;
    if (!resolvedAddress && lat !== null && lon !== null) {
      resolvedAddress = await resolveAddress(lat, lon);
    }

    const mapsUrl =
      lat !== null && lon !== null ? `https://maps.google.com/?q=${lat},${lon}` : null;

    const normalizedStatus = (order?.status || "pending").toString().toLowerCase();
    const normalizedLiters =
      liters !== undefined && liters !== null
        ? Number(liters)
        : order?.product?.items?.[0]?.quantity !== undefined
        ? Number(order.product.items[0].quantity)
        : null;

    const payload = {
      courierChatId,
      customerChatId:
        customer?.chatId || customer?.telegramId || customer?.id || null,
      customerUserId:
        customer?.userId ||
        customer?.id ||
        customer?.chatId ||
        customer?.telegramId ||
        null,
      orderId:
        order?.id != null
          ? String(order.id)
          : order?.orderId != null
          ? String(order.orderId)
          : null,
      productName: productName || order?.product?.name || "Sut",
      liters: Number.isFinite(normalizedLiters) ? normalizedLiters : null,
      address: resolvedAddress || customer?.address || null,
      latitude: lat,
      longitude: lon,
      mapsUrl,
      phone: customer?.phone || customer?.phoneNumber || null,
      customerName: customer?.fullName || customer?.username || null,
      status: normalizedStatus,
      payload: {
        order,
        customer,
      },
    };

    if (!payload.orderId) {
      payload.orderId = `${courierChatId}-${Date.now()}`;
    }

    const existing =
      payload.orderId &&
      (await CourierOrderModel.findOne({
        where: {
          courierChatId: payload.courierChatId,
          orderId: payload.orderId,
        },
      }));

    if (existing) {
      return await existing.update(payload);
    }

    return await CourierOrderModel.create(payload);
  } catch (error) {
    console.error("createCourierOrderRecord failed:", error.message || error);
    return null;
  }
}

module.exports = {
  findFirstCourierWithinRadius,
  createCourierOrderRecord,
  rememberOrderAssignment,
  getNextCourierForOrder,
  clearOrderAssignment,
  getOrderIdentifier,
  getOrderAssignment,
  markOrderAccepted,
};
