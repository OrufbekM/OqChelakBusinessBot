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
 *
 * @param {Array|Object} couriersSource Either an array of users or the User model/db object
 * @param {{ latitude: number|string, longitude: number|string }} customer
 * @returns {Promise<null|{ courier: { id?: number, latitude: number, longitude: number, deliveryRadius: number }, distanceKm: number, customerAddress: string }>}
 */
async function findFirstCourierWithinRadius(User, customer) {
  if (!customer) {
    return null;
  }

  const CourierModel = User ?? db?.User ?? db;
  if (!CourierModel || typeof CourierModel.findAll !== "function") {
    return null;
  }

  const couriers = await CourierModel.findAll();

  if (!Array.isArray(couriers) || couriers.length === 0) {
    return null;
  }

  const customerCoords = buildCoordinate(customer);
  if (!customerCoords) {
    return null;
  }

  // Customer delivery radius is not considered; only courier's radius matters.

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
        `Buyurtma manzili ${customerAddress}`,
        `Masofa: ${distanceKm} km`,
      ].join("\n")
    );

    return {
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

module.exports = {
  findFirstCourierWithinRadius,
};


