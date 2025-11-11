require("dotenv").config();

const axios = require("axios");
const ngrok = require("ngrok");

const BOT_TOKEN = process.env.BOT_TOKEN || "";
if (!BOT_TOKEN) {
  console.warn("BOT_TOKEN is not set. Telegram API calls will fail.");
}

const telegram = axios.create({
  baseURL: `https://api.telegram.org/bot${BOT_TOKEN}`,
  timeout: 15000,
});

async function setWebhook(fullUrl) {
  if (!BOT_TOKEN) return;
  try {
    const resp = await telegram.post("/setWebhook", { url: fullUrl });
    console.log("setWebhook response:", resp.data);
  } catch (err) {
    console.error(
      "setWebhook failed:",
      err.response?.data || err.message || err
    );
    throw err;
  }
}

function normalizeUrl(publicUrl, webhookPath) {
  const base = (publicUrl || "").replace(/\/+$/, "");
  const path =
    webhookPath && webhookPath.startsWith("/") ? webhookPath : `/${webhookPath || ""}`;
  return `${base}${path}`;
}

async function startNgrokAndSetWebhook(port, webhookPath) {
  const authtoken = process.env.NGROK_AUTHTOKEN || process.env.NGROK_TOKEN;
  if (authtoken) {
    await ngrok.authtoken(authtoken);
  }

  const publicUrl =
    process.env.PUBLIC_URL ||
    (await ngrok.connect({
      addr: port,
    }));

  const webhookUrl = normalizeUrl(publicUrl, webhookPath);
  await setWebhook(webhookUrl);
  return publicUrl;
}

async function getWebhookInfo() {
  if (!BOT_TOKEN) return { ok: false, description: "BOT_TOKEN missing" };
  try {
    const resp = await telegram.get("/getWebhookInfo");
    return resp.data;
  } catch (err) {
    return err.response?.data || { ok: false, error: err.message || String(err) };
  }
}

async function deleteWebhook() {
  if (!BOT_TOKEN) return { ok: false, description: "BOT_TOKEN missing" };
  try {
    const resp = await telegram.post("/deleteWebhook");
    return resp.data;
  } catch (err) {
    return err.response?.data || { ok: false, error: err.message || String(err) };
  }
}

module.exports = {
  telegram,
  setWebhook,
  startNgrokAndSetWebhook,
  getWebhookInfo,
  deleteWebhook,
  normalizeUrl,
};


