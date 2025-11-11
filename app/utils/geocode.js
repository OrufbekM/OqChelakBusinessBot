require("dotenv").config();

const axios = require("axios");

async function reverseGeocode(lat, lng) {
  try {
    const email = process.env.NOMINATIM_EMAIL || undefined;
    const resp = await axios.get("https://nominatim.openstreetmap.org/reverse", {
      params: {
        format: "jsonv2",
        lat,
        lon: lng,
        "accept-language": "uz",
        email,
      },
      headers: {
        "User-Agent": `oqchelak-busnessBot/1.0 (${email || "no-email-provided"})`,
      },
      timeout: 10000,
    });
    const data = resp.data || {};
    return data.display_name || null;
  } catch (e) {
    console.error("reverseGeocode (Nominatim) failed:", e.response?.data || e.message || e);
    return null;
  }
}

async function reverseGeocodeDetailed(lat, lng) {
  try {
    const email = process.env.NOMINATIM_EMAIL || undefined;
    const resp = await axios.get("https://nominatim.openstreetmap.org/reverse", {
      params: {
        format: "jsonv2",
        lat,
        lon: lng,
        "accept-language": "uz",
        email,
        addressdetails: 1,
      },
      headers: {
        "User-Agent": `oqchelak-busnessBot/1.0 (${email || "no-email-provided"})`,
      },
      timeout: 10000,
    });
    return resp.data || null;
  } catch (e) {
    console.error("reverseGeocodeDetailed (Nominatim) failed:", e.response?.data || e.message || e);
    return null;
  }
}

function formatUzAddress(address) {
  if (!address || typeof address !== "object") return null;
  const village = address.village || address.hamlet || address.suburb || address.neighbourhood;
  const town = address.town;
  const city = address.city || address.city_district || address.municipality;
  const state = address.state;
  const cleanState = state ? String(state).replace(/\s+viloyati$/i, "").trim() : null;

  const locality = village || town || null;
  if (locality && (city || cleanState)) {
    return `${locality}, ${city || cleanState}`;
  }
  if (city || cleanState) {
    return `${city || cleanState}`;
  }
  return null;
}

module.exports = {
  reverseGeocode,
  reverseGeocodeDetailed,
  formatUzAddress,
};


