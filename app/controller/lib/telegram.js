require("dotenv").config();

const { telegram } = require("./axios");
const models = require("../../models");
const { reverseGeocode, reverseGeocodeDetailed, formatUzAddress } = require("../../utils/geocode");

const BOT_TOKEN = process.env.BOT_TOKEN || "";

const userStateById = new Map();

function getWebhookPath() {
  if (process.env.WEBHOOK_PATH) return process.env.WEBHOOK_PATH;
  return BOT_TOKEN ? `/webhook/${BOT_TOKEN}` : `/webhook`;
}

async function sendMessage(chatId, text, extra) {
  if (!BOT_TOKEN) {
    console.warn("BOT_TOKEN is not set. Skipping sendMessage.");
    return;
  }
  try {
    const resp = await telegram.post("/sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      ...extra,
    });
    console.log("sendMessage ok:", resp.data);
  } catch (err) {
    console.error(
      "sendMessage failed:",
      err.response?.data || err.message || err
    );
  }
}

async function askPhone(chatId) {
  await sendMessage(chatId, "Iltimos, raqamingizni ulashing:", {
    reply_markup: {
      keyboard: [[{ text: "Raqamni ulashish 📱", request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
}

async function askLocation(chatId) {
  await sendMessage(chatId, "Iltimos, manzilingizni ulashing:", {
    reply_markup: {
      keyboard: [[{ text: "Manzilni ulashish 📍", request_location: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
}

async function handleUpdate(req, res) {
  try {
    const update = req.body;
    console.log("Update received:", JSON.stringify(update));

    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message.chat.id;
      const data = cq.data;

      if (data === "confirm_yes") {
        userStateById.set(chatId, { expected: "delivery_radius" });
        await sendMessage(chatId, "Sut mahsulotlarini qayergacha yetkazib bera olasiz?", {
          reply_markup: {
            keyboard: [
              [{ text: "2 km"}, {text: "4 km"}],
              [{ text: "6 km"}, {text: "8 km"}],
              [{ text: "boshqa"}, {text: "Hamma joyga"}]
            ],
            resize_keyboard: true,
            one_time_keyboard: false,
          },
        });
      } else if (data === "confirm_no") {
        await sendMessage(chatId, "Bekor qilindi. /start bilan qayta boshlang.", {
          reply_markup: { remove_keyboard: true },
        });
      }

      await telegram.post("/answerCallbackQuery", {
        callback_query_id: cq.id,
      });

      res.sendStatus(200);
      return;
    }

    const message = update && (update.message || update.edited_message);
    if (message && message.chat) {
      const chatId = message.chat.id;
      const text = typeof message.text === "string" ? message.text.trim() : "";

      if (message.location && typeof message.location.latitude === "number") {
        const st = userStateById.get(chatId) || {};
        st.location = {
          latitude: message.location.latitude,
          longitude: message.location.longitude,
        };
        st.expected = null;
        userStateById.set(chatId, st);

        try {
          await models.User.update(
            {
              latitude: st.location.latitude,
              longitude: st.location.longitude,
              currentLocation: "telegram",
            },
            { where: { chatId } }
          );
        } catch (e) {
          console.error("Sequelize update (location) failed:", e.message || e);
        }

        const user = await models.User.findOne({ where: { chatId } });
        const uname = user?.username ? `@${user.username}` : "—";
        const fullName = user?.fullName || "—";
        const phone = user?.phone || "—";
        let address = "—";
        if (user?.latitude && user?.longitude) {
          const detailed = await reverseGeocodeDetailed(user.latitude, user.longitude);
          const formatted = detailed && detailed.address ? formatUzAddress(detailed.address) : null;
          if (formatted) {
            address = formatted;
          } else {
            const fallback = await reverseGeocode(user.latitude, user.longitude);
            address = fallback || `${user.latitude}, ${user.longitude}`;
          }
        }

        await sendMessage(chatId, `Ma'lumotlaringiz:\nUsername: ${uname}\nFull name: ${fullName}\nTelefon: ${phone}\nManzil: ${address}\n\nMa'lumotlar to'g'rimi?`, {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "Ha ✅", callback_data: "confirm_yes" },
                { text: "Yo'q ❌", callback_data: "confirm_no" },
              ],
            ],
          },
        });
        res.sendStatus(200);
        return;
      }

      if (message.contact && message.contact.phone_number) {
        const st = userStateById.get(chatId) || {};
        st.phone = message.contact.phone_number;
        st.expected = "location";
        userStateById.set(chatId, st);

        try {
          await models.User.update(
            { phone: st.phone },
            { where: { chatId } }
          );
        } catch (e) {
          console.error("Sequelize update (phone) failed:", e.message || e);
        }

        await sendMessage(chatId, "Rahmat! Raqamingiz qabul qilindi ✅");
        await askLocation(chatId);
        res.sendStatus(200);
        return;
      }

      const state = userStateById.get(chatId) || {};

      if (state.expected === "delivery_radius") {
        if (text === "Hamma joyga") {
          try {
            await models.User.update(
              { deliveryRadius: null },
              { where: { chatId } }
            );
          } catch (e) {
            console.error("Sequelize update (deliveryRadius unlimited) failed:", e.message || e);
          }
          await sendMessage(chatId, "Tasdiqlandi ✅", {
            reply_markup: {
              keyboard: [[{ text: "Maxsulot qo'shish ➕" }]],
              resize_keyboard: true,
              one_time_keyboard: false,
            },
          });
          userStateById.delete(chatId);
          res.sendStatus(200);
          return;
        } else if (text === "boshqa") {
          userStateById.set(chatId, { expected: "delivery_radius_custom" });
          await sendMessage(chatId, "Necha km yetkazib bera olasiz? (Raqam kiriting, masalan: 10)", {
            reply_markup: { remove_keyboard: true },
          });
          res.sendStatus(200);
          return;
        } else {
          const match = text.match(/^(\d+(?:\.\d+)?)\s*km?$/i);
          if (match) {
            const radius = parseFloat(match[1]);
            try {
              await models.User.update(
                { deliveryRadius: radius },
                { where: { chatId } }
              );
            } catch (e) {
              console.error("Sequelize update (deliveryRadius) failed:", e.message || e);
            }
            await sendMessage(chatId, "Tasdiqlandi ✅", {
              reply_markup: {
                keyboard: [[{ text: "Maxsulot qo'shish ➕" }]],
                resize_keyboard: true,
                one_time_keyboard: false,
              },
            });
            userStateById.delete(chatId);
            res.sendStatus(200);
            return;
          }
        }
      }

      if (state.expected === "delivery_radius_custom") {
        const radius = parseFloat(text);
        if (!isNaN(radius) && radius > 0) {
          try {
            await models.User.update(
              { deliveryRadius: radius },
              { where: { chatId } }
            );
          } catch (e) {
            console.error("Sequelize update (deliveryRadius custom) failed:", e.message || e);
          }
          await sendMessage(chatId, "Tasdiqlandi ✅", {
            reply_markup: {
              keyboard: [[{ text: "Maxsulot qo'shish ➕" }]],
              resize_keyboard: true,
              one_time_keyboard: false,
            },
          });
          userStateById.delete(chatId);
          res.sendStatus(200);
          return;
        } else {
          await sendMessage(chatId, "Iltimos, to'g'ri raqam kiriting (masalan: 10)");
          res.sendStatus(200);
          return;
        }
      }

      if (text === "/start" || text.startsWith("/start")) {
        const from = message.from || {};
        const fullName = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
        const username = from.username || null;

        try {
          await models.User.upsert({
            chatId,
            fullName: fullName,
            username,
          });
        } catch (e) {
          console.error("Sequelize upsert (start) failed:", e.message || e);
        }

        userStateById.set(chatId, { expected: "phone" });
        await sendMessage(chatId, "Oq Chelack Business ga hush kelibsiz! Ro'yhatdan o'tamiz.\nTanlang:");
        await askPhone(chatId);
        res.sendStatus(200);
        return;
      }

      if (text === "/help") {
        await sendMessage(
          chatId,
          "Mavjud buyruqlar:\n/start - Boshlash va ro'yhatdan o'tish\n/help - Yordam"
        );
        res.sendStatus(200);
        return;
      }

      if (text) {
        await sendMessage(
          chatId,
          "Buyruq tushunilmadi. /start yoki /help ni ishlating."
        );
        res.sendStatus(200);
        return;
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Telegram handleUpdate error:", err.message || err);
    res.sendStatus(200);
  }
}

module.exports = {
  getWebhookPath,
  handleUpdate,
  sendMessage,
};


