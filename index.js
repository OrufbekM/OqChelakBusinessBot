require("dotenv").config();

const express = require("express");
const path = require("path");

const dbConfig = require(path.join(__dirname, "app", "config", "db.config.js"));

const { handleUpdate, getWebhookPath } = require(path.join(
  __dirname,
  "app",
  "controller",
  "lib",
  "telegram"
));
const { getWebhookInfo, deleteWebhook, normalizeUrl } = require(path.join(
  __dirname,
  "app",
  "controller",
  "lib",
  "axios"
));
const models = require(path.join(__dirname, "app", "models", "index.js"));
const verificationRouter = require(path.join(
  __dirname,
  "app",
  "routers",
  "verification.routes.js"
));
const usersRouter = require(path.join(
  __dirname,
  "app",
  "routers",
  "users.routes.js"
));

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT || "3000", 10);
const WEBHOOK_PATH = getWebhookPath();

// Telegram webhook endpoint
app.post(WEBHOOK_PATH, handleUpdate);

app.use("/api/verification", verificationRouter);
app.use("/api/users", usersRouter);

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    webhook: WEBHOOK_PATH,
    db: {
      host: dbConfig.HOST,
      user: dbConfig.USER,
      db: dbConfig.DB,
      dialect: dbConfig.dialect,
    },
  });
});

app.get("/debug/webhook-info", async (req, res) => {
  const info = await getWebhookInfo();
  res.json({
    webhookPath: WEBHOOK_PATH,
    info,
  });
});

app.post("/debug/reset-webhook", async (req, res) => {
  try {
    const renderUrl = process.env.RENDER_EXTERNAL_URL;
    const fullUrl = normalizeUrl(renderUrl, WEBHOOK_PATH);

    const del = await deleteWebhook();
    await new Promise((r) => setTimeout(r, 250));

    const set = await (async () => {
      try {
        const resp = await require("./app/controller/lib/axios").telegram.post(
          "/setWebhook",
          { url: fullUrl }
        );
        return resp.data;
      } catch (err) {
        return (
          err.response?.data || { ok: false, error: err.message || String(err) }
        );
      }
    })();

    res.json({ deleted: del, set, fullUrl, webhookPath: WEBHOOK_PATH });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// Server start + webhook setup
app.listen(PORT, async () => {
  try {
    await models.initModels();

    const renderUrl = process.env.RENDER_EXTERNAL_URL || "https://oqchelakbusinessbot.onrender.com";
    const fullUrl = normalizeUrl(renderUrl, WEBHOOK_PATH);

    await deleteWebhook();
    await new Promise(r => setTimeout(r, 250));

    const axiosLib = require("./app/controller/lib/axios");
    const response = await axiosLib.telegram.post("/setWebhook", { url: fullUrl });

    console.log(`Server listening on port ${PORT}`);
    console.log("Webhook set to:", fullUrl);
  } catch (err) {
    console.error("Failed to set webhook:", err.message || err);
  }
});
