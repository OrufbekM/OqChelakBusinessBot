require("dotenv").config();

const { telegram } = require("./axios");
const models = require("../../models");
const {
  reverseGeocode,
  reverseGeocodeDetailed,
  formatUzAddress,
} = require("../../utils/geocode");
const {
  createCourierOrderRecord,
  getNextCourierForOrder,
  clearOrderAssignment,
  markOrderAccepted,
  getOrderAssignment,
} = require("../verification.controller");
const axios = require("axios");

const { t, changeLanguage } = require("../../config/i18n");

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const STATUS_API_BASE =
  process.env.STATUS_API_BASE ||
  "https://oqchelak-bot.onrender.com";

const userStateById = new Map();

const ORDER_STATUS_EMOJI = {
  pending: "⏳",
  processing: "🚚",
  completed: "✅",
  cancelled: "❌",
};

// Helper function to get user's language
async function getUserLanguage(chatId) {
  try {
    const user = await models.User.findOne({ where: { chatId } });
    return user?.language || "uz";
  } catch (error) {
    return "uz";
  }
}

// Helper function to translate text
async function translate(chatId, key, data = {}) {
  try {
    const language = await getUserLanguage(chatId);
    return await t(key, { lng: language, ...data });
  } catch (error) {
    console.error(`Error translating key "${key}":`, error);
    return key;
  }
}

// Helper function to send translated message
async function sendTranslatedMessage(chatId, key, extra = {}, data = {}) {
  try {
    const text = await translate(chatId, key, data);
    return await sendMessage(chatId, text, extra);
  } catch (error) {
    console.error("Error in sendTranslatedMessage:", error);
    return await sendMessage(chatId, key, extra);
  }
}

// Helper to get translated keyboard text
async function getTranslatedKeyboard(chatId) {
  try {
    return {
      phone_share: await translate(chatId, "phone_share"),
      location_share: await translate(chatId, "location_share"),
      back: await translate(chatId, "back"),
      yes: await translate(chatId, "yes"),
      no: await translate(chatId, "no"),
      delivered: await translate(chatId, "delivered"),
      not_delivered: await translate(chatId, "not_delivered"),
      my_orders: await translate(chatId, "my_orders"),
      change_language: await translate(chatId, "change_language"),
    };
  } catch (error) {
    console.error("Error getting translated keyboard:", error);
    return {
      phone_share: "Raqamni ulashish",
      location_share: "Manzilni ulashish",
      back: "Orqaga",
      yes: "Ha",
      no: "Yo'q",
      delivered: "Yetkazildi",
      not_delivered: "Yetkazilmadi",
      my_orders: "Buyurtmalarim",
      change_language: "Tilni o'zgartirish",
    };
  }
}

function isValidExternalOrderId(orderId) {
  if (orderId === null || orderId === undefined) return false;
  const str = String(orderId).trim();
  return str.length > 0 && /^\d+$/.test(str);
}

function resolveCustomerChatId(order = {}) {
  return (
    order.customerChatId ||
    order.customerUserId ||
    order.customerId ||
    order?.payload?.customer?.userId ||
    order?.payload?.customer?.chatId ||
    order?.payload?.customer?.telegramId ||
    order?.payload?.order?.userId ||
    order?.payload?.order?.customerId ||
    order?.payload?.customer?.id ||
    null
  );
}

function resolveExternalOrderId(order = {}) {
  const candidates = [
    order.orderId,
    order?.payload?.order?.id,
    order?.payload?.orderId,
    order?.payload?.order?.orderId,
  ];
  for (const candidate of candidates) {
    if (isValidExternalOrderId(candidate)) {
      return String(candidate).trim();
    }
  }
  return null;
}

function toNumericId(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (value === null || value === undefined) {
    return null;
  }

  const str = String(value).trim();
  if (/^\d+$/.test(str)) {
    const num = Number(str);
    return Number.isFinite(num) ? num : null;
  }

  return null;
}

// Format phone number to +998 format
function formatPhoneNumber(phone) {
  if (!phone) return null;
  
  // Barcha raqam bo'lmagan belgilarni olib tashlash
  const cleaned = phone.replace(/\D/g, "");
  
  // +998... formatida bo'lsa
  if (cleaned.startsWith('998') && cleaned.length === 12) {
    return `+${cleaned}`;
  }
  
  // Faqat 9 ta raqam bo'lsa (90... formatida)
  if (cleaned.length === 9 && cleaned.startsWith('9')) {
    return `+998${cleaned}`;
  }
  
  // + bilan boshlansa
  if (cleaned.startsWith('998') && phone.startsWith('+')) {
    return phone; // Aslini qaytarish
  }
  
  return null;
}
// Format phone for external API
function formatPhoneNumberForApi(phone) {
  if (!phone) return null;
  
  // Avval tozalash
  const formattedPhone = formatPhoneNumber(phone);
  if (!formattedPhone) return null;
  
  // Formatlash: +998 XX XXX XX XX
  const digits = formattedPhone.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith('998')) {
    const country = digits.slice(0, 3); // 998
    const operator = digits.slice(3, 5); // 90
    const part1 = digits.slice(5, 8);   // 123
    const part2 = digits.slice(8, 12);  // 4567
    return `+${country} ${operator} ${part1} ${part2}`;
  }
  
  return formattedPhone;
}

// Get customer's phone number for API calls
async function getCustomerPhoneForApi(chatId) {
  try {
    const user = await models.User.findOne({
      where: { chatId },
      attributes: ["phone"],
      raw: true,
    });
    
    if (!user || !user.phone) {
      console.error(`No phone found for chatId: ${chatId}`);
      return null;
    }
    
    // Telefon raqamni tozalash
    return formatPhoneNumber(user.phone);
  } catch (error) {
    console.error(`Error getting customer phone for chatId ${chatId}:`, error);
    return null;
  }
}

// Validate phone number
function isValidPhoneNumber(phone) {
  return formatPhoneNumber(phone) !== null;
}

// Build order notification text
async function buildOrderNotificationText(customerChatId, productName, liters, opts = {}) {
  let address = "—";
  let lat;
  let lon;
  let mapsUrl = "";
  const name = productName || "Milk";
  const qty = liters ? `${liters}L` : "—";

  let customerName = "—";
  let phone = "—";

  try {
    const user = await models.User.findOne({
      where: { chatId: customerChatId },
    });
    lat = typeof opts.latitude === "number" ? opts.latitude : user?.latitude;
    lon = typeof opts.longitude === "number" ? opts.longitude : user?.longitude;

    customerName = opts.customerName || user?.fullName || user?.username || customerName;
    phone = opts.phone || user?.phone || phone;

    if (typeof lat === "number" && typeof lon === "number") {
      const detailed = await reverseGeocodeDetailed(lat, lon);
      const formatted = detailed?.address
        ? formatUzAddress(detailed.address)
        : null;
      address = formatted || (await reverseGeocode(lat, lon)) || `${lat}, ${lon}`;
      mapsUrl = `https://maps.google.com/?q=${lat},${lon}`;
    }
  } catch (e) {
    console.error("buildOrderNotificationText failed:", e.message || e);
  }

  const viewOnMap = await translate(customerChatId, "view_on_map");
  const locationText = `<a href="${escapeHtml(mapsUrl)}">${viewOnMap}</a>`;

  return await translate(customerChatId, "order_notification", {
    productName: name,
    quantity: qty,
    address: address,
    location: locationText,
    customerName,
    phone,
  });
}

// Send order request to seller
async function notifySellerAboutOrder({
  sellerChatId,
  customerChatId,
  orderId,
  productName = "Milk",
  liters,
  latitude,
  longitude,
  customerName,
  phone,
}) {
  const text = await buildOrderNotificationText(customerChatId, productName, liters, {
    latitude,
    longitude,
    customerName,
    phone,
  });

  const keyboardText = await getTranslatedKeyboard(sellerChatId);

  const inline_keyboard = [
    [
      {
        text: keyboardText.yes,
        callback_data: `order_confirm_yes:${customerChatId}:${orderId || ""}`,
      },
      {
        text: keyboardText.no,
        callback_data: `order_confirm_no:${customerChatId}:${orderId || ""}`,
      },
    ],
  ];
  await sendMessage(sellerChatId, text, { reply_markup: { inline_keyboard } });
}

function getWebhookPath() {
  if (process.env.WEBHOOK_PATH) return process.env.WEBHOOK_PATH;
  return BOT_TOKEN ? `/webhook/${BOT_TOKEN}` : `/webhook`;
}

function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getCourierOrderUniqueKey(order = {}) {
  const externalId = resolveExternalOrderId(order);
  if (externalId) {
    const customerId = resolveCustomerChatId(order) || order.customerChatId || "";
    return `ext:${customerId}:${externalId}`;
  }
  if (order.orderId) {
    return `local:${order.orderId}`;
  }
  if (order.id) {
    return `db:${order.id}`;
  }
  return null;
}

async function formatCourierOrderForMessage(chatId, order, showQuestion = true) {
  const productName = escapeHtml(order.productName || "—");
  const liters =
    order.liters !== null && order.liters !== undefined
      ? escapeHtml(`${order.liters}`)
      : "—";
  const address = escapeHtml(order.address || "—");
  const phone = escapeHtml(order.phone || "—");
  const customerName = escapeHtml(order.customerName || "—");

  const orderName = await translate(chatId, "order_name");
  const litersText = await translate(chatId, "liters");
  const addressText = await translate(chatId, "address");
  const phoneText = await translate(chatId, "phone");
  const customerText = await translate(chatId, "customer");
  const locationText = await translate(chatId, "location");
  const viewOnMap = await translate(chatId, "view_on_map");

  const orderNameLine = ` ${orderName}: ${productName}`;
  const litersLine = ` ${litersText}: ${liters}`;
  const addressLine = ` ${addressText}: ${address}`;
  const phoneLine = ` ${phoneText}: ${phone}`;
  const customerLine = ` ${customerText}: ${customerName}`;

  let locationLine = ` ${locationText}: —`;
  const mapsUrl =
    order.mapsUrl ||
    (order.latitude && order.longitude
      ? `https://maps.google.com/?q=${order.latitude},${order.longitude}`
      : null);

  if (mapsUrl) {
    locationLine = ` ${locationText}: <a href="${escapeHtml(mapsUrl)}">${viewOnMap}</a>`;
  }

  const parts = [orderNameLine, litersLine, addressLine, locationLine, phoneLine, customerLine];

  if (showQuestion) {
    const deliveryQuestion = await translate(chatId, "order_delivery_question");
    parts.push(`\n${deliveryQuestion}`);
  }

  return parts.filter(Boolean).join("\n");
}

async function getCourierOrdersByChatId(chatId, limit = null) {
  if (!models?.CourierOrder) {
    return [];
  }
  const options = {
    where: { courierChatId: chatId },
    order: [["createdAt", "DESC"]],
  };
  if (limit) {
    options.limit = limit;
  }
  return models.CourierOrder.findAll(options);
}

// Delete previous order messages
async function deletePreviousOrderMessages(chatId) {
  try {
    const state = userStateById.get(chatId) || {};
    const previousMessages = state.orderMessages || [];

    for (const msgId of previousMessages) {
      try {
        await telegram.post("/deleteMessage", {
          chat_id: chatId,
          message_id: msgId,
        });
      } catch (e) {
        console.log("Message already deleted:", e.message || e);
      }
    }

    state.orderMessages = [];
    userStateById.set(chatId, state);

    return true;
  } catch (error) {
    console.error("Error deleting previous order messages:", error);
    return false;
  }
}

// Send each order as a separate message
async function sendCourierOrdersList(chatId) {
  try {
    await deletePreviousOrderMessages(chatId);

    const allOrders = await getCourierOrdersByChatId(chatId);
    const visibleOrders = (allOrders || []).filter((o) => {
      const s = (o.status || "").toLowerCase();
      return s !== "cancelled" && s !== "completed";
    });
    

    if (!visibleOrders || visibleOrders.length === 0) {
      const msgId = await sendTranslatedMessage(chatId, "no_orders");
      if (msgId) {
        const state = userStateById.get(chatId) || {};
        state.orderMessages = [msgId];
        userStateById.set(chatId, state);
      }
      return;
    }

    const seenKeys = new Set();
    const uniqueOrders = [];
    for (const order of visibleOrders) {
      const key = getCourierOrderUniqueKey(order);
      if (key && seenKeys.has(key)) {
        continue;
      }
      if (key) {
        seenKeys.add(key);
      }
      uniqueOrders.push(order);
    }

    const keyboardText = await getTranslatedKeyboard(chatId);
    const state = userStateById.get(chatId) || {};
    state.orderMessages = [];

    for (const order of uniqueOrders) {
      const orderText = await formatCourierOrderForMessage(chatId, order, order.status !== "completed");

      const inline_keyboard = [];
      if (order.status !== "completed") {
        inline_keyboard.push([
          {
            text: keyboardText.delivered,
            callback_data: `order_delivered:${order.id}`,
          },
          {
            text: keyboardText.not_delivered,
            callback_data: `order_not_delivered:${order.id}`,
          },
        ]);
      }

      const msgId = await sendMessage(chatId, orderText, {
        reply_markup: { inline_keyboard },
      });

      if (msgId) {
        state.orderMessages.push(msgId);
      }
    }

    userStateById.set(chatId, state);
  } catch (e) {
    console.error("sendCourierOrdersList failed:", e.message || e);
    await sendTranslatedMessage(chatId, "orders_error");
  }
}

async function sendCourierOrderDetails(chatId, orderId, ordersListMessageId = null) {
  try {
    const order = await models.CourierOrder.findByPk(orderId);

    if (!order) {
      await sendTranslatedMessage(chatId, "order_not_found");
      return;
    }

    const allOrders = await getCourierOrdersByChatId(chatId);
    const orderIndex = allOrders.findIndex((o) => o.id === orderId);
    const orderNumber =
      orderIndex !== -1
        ? `${orderIndex + 1}. ${order.productName || await translate(chatId, "product")} ${
            order.liters ? `${order.liters}L` : ""
          }`
        : "";

    const orderText = await formatCourierOrderForMessage(chatId, order, order.status !== "completed");
    const fullText = orderNumber ? `${orderNumber}\n\n${orderText}` : orderText;

    const keyboardText = await getTranslatedKeyboard(chatId);
    const inline_keyboard = [];

    if (order.status !== "completed") {
      inline_keyboard.push([
        {
          text: keyboardText.yes,
          callback_data: `order_delivered:${order.id}:${ordersListMessageId || ""}`,
        },
        {
          text: keyboardText.no,
          callback_data: `order_not_delivered:${order.id}:${ordersListMessageId || ""}`,
        },
      ]);
    }

    inline_keyboard.push([
      {
        text: keyboardText.back,
        callback_data: `courier_orders_back:${ordersListMessageId || ""}`,
      },
    ]);

    const replyMarkup = {
      inline_keyboard: inline_keyboard,
    };

    await sendMessage(chatId, fullText, { reply_markup: replyMarkup });
  } catch (e) {
    console.error("sendCourierOrderDetails failed:", e.message || e);
    await sendTranslatedMessage(chatId, "order_details_error");
  }
}

async function updateCourierOrderStatusLocal({ courierChatId, customerChatId, orderId, status }) {
  if (!models?.CourierOrder) return;
  const normalizedStatus = (status || "").toString().toLowerCase();
  const where = {};
  if (courierChatId) where.courierChatId = courierChatId;
  if (orderId) where.orderId = String(orderId);
  if (customerChatId) where.customerChatId = customerChatId;
  if (Object.keys(where).length === 0) return;
  try {
    await models.CourierOrder.update(
      { status: normalizedStatus },
      {
        where,
      }
    );
  } catch (err) {
    console.error("updateCourierOrderStatusLocal failed:", err.message || err);
  }
}

// Modified to use phone number as userId
async function getUserOrders(identifier) {
  try {
    console.log("getUserOrders called with identifier:", identifier, "type:", typeof identifier);
    
    // Agar identifier raqam bo'lsa (userId), to'g'ridan-to'g'ri ishlatamiz
    if (typeof identifier === 'number' || (typeof identifier === 'string' && /^\d+$/.test(identifier))) {
      const numericId = toNumericId(identifier);
      if (!numericId) {
        console.error("Invalid userId format:", identifier);
        return null;
      }
      
      const url = `${STATUS_API_BASE}/api/status?userId=${encodeURIComponent(numericId)}`;
      console.log("Calling getUserOrders by userId with URL:", url);
      
      try {
        const { data } = await axios.get(url, { timeout: 15000 });
        console.log("getUserOrders response:", data);
        return data;
      } catch (apiError) {
        console.error("API error for userId:", apiError.message || apiError);
        
        // Agar userId orqali topilmasa, telefon raqam orqali urinib ko'ramiz
        // Avval telefon raqamni topish
        const user = await models.User.findOne({
          where: { id: numericId }
        });
        
        if (user && user.phone) {
          const phoneUrl = `${STATUS_API_BASE}/api/status?phone=${encodeURIComponent(formatPhoneNumberForApi(user.phone))}`;
          console.log("Trying by phone with URL:", phoneUrl);
          
          try {
            const { data: phoneData } = await axios.get(phoneUrl, { timeout: 15000 });
            console.log("getUserOrders response by phone:", phoneData);
            return phoneData;
          } catch (phoneError) {
            console.error("API error for phone:", phoneError.message || phoneError);
          }
        }
        
        return null;
      }
    }
    // Agar identifier telefon raqam bo'lsa
    else if (typeof identifier === 'string') {
      // Telefon raqamni formatlash
      const formattedPhone = formatPhoneNumber(identifier);
      if (!formattedPhone) {
        console.error("Invalid phone number format:", identifier);
        return null;
      }
      
      const phoneUrl = `${STATUS_API_BASE}/api/status?phone=${encodeURIComponent(formatPhoneNumberForApi(formattedPhone))}`;
      console.log("Calling getUserOrders by phone with URL:", phoneUrl);
      
      try {
        const { data } = await axios.get(phoneUrl, { timeout: 15000 });
        console.log("getUserOrders response by phone:", data);
        return data;
      } catch (phoneError) {
        console.error("API error for phone:", phoneError.message || phoneError);
        return null;
      }
    } else {
      console.error("Invalid identifier type:", typeof identifier, "value:", identifier);
      return null;
    }
  } catch (e) {
    console.error("getUserOrders failed:", e.message || e);
    return null;
  }
}

async function getUserOrdersWithRetry(identifier, retries = 2, delayMs = 800) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const resp = await getUserOrders(identifier);
    if (resp) return resp;
    lastError = new Error("getUserOrders returned null");
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  console.error("getUserOrdersWithRetry exhausted for identifier:", identifier, lastError?.message);
  return null;
}

// Modified to always use userId for API calls
async function updateOrderStatus(userId, orderId, status, courierPhone = null) {
  try {
    const numericUserId = toNumericId(userId);
    if (!numericUserId) {
      throw new Error(`Invalid userId format: ${userId}`);
    }

    const numericOrderId = toNumericId(orderId);
    if (!numericOrderId) {
      throw new Error(`Invalid orderId format: ${orderId}`);
    }

    const url = `${STATUS_API_BASE}/api/status/user/${encodeURIComponent(numericUserId)}/order/${encodeURIComponent(numericOrderId)}`;
    
    console.log("Calling updateOrderStatus with URL:", url);

    const updateData = { status };

    // Agar buyurtma yetkazilgan bo'lsa va kurer telefon raqami berilgan bo'lsa
    if (status === "completed" && courierPhone) {
      const formattedCourierPhone = formatPhoneNumberForApi(courierPhone) || courierPhone;
      updateData.phoneNumber = formattedCourierPhone;

      // Kurer ma'lumotlarini seller uchun alohida jo'natish
      try {
        await axios.post(
          `${STATUS_API_BASE}/api/status/seller/info/`,
          {
            orderId: numericOrderId,
            phoneNumber: formattedCourierPhone,
          },
          {
            timeout: 10000,
            headers: { "Content-Type": "application/json" },
          }
        );
        console.log("Seller info sent successfully for order:", numericOrderId);
      } catch (webhookError) {
        console.error("Failed to send courier phone to webhook:", webhookError.message || webhookError);
      }
    }

    console.log("Sending update data:", updateData);
    
    // PUT request yuborish
    const { data } = await axios.put(url, updateData, {
      timeout: 15000,
      headers: { "Content-Type": "application/json" },
    });
    
    console.log("updateOrderStatus response:", data);
    return data;
  } catch (e) {
    console.error("updateOrderStatus failed:", {
      url: e.config?.url,
      method: e.config?.method,
      data: e.config?.data,
      status: e.response?.status,
      response: e.response?.data,
      message: e.message
    });
    throw e;
  }
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
    return resp.data.result.message_id;
  } catch (err) {
    console.error("sendMessage failed:", err.response?.data || err.message || err);
  }
}

async function askPhone(chatId) {
  const keyboardText = await getTranslatedKeyboard(chatId);

  await sendTranslatedMessage(chatId, "ask_phone", {
    reply_markup: {
      keyboard: [[{ text: keyboardText.phone_share, request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
}

async function askLocation(chatId) {
  const keyboardText = await getTranslatedKeyboard(chatId);

  await sendTranslatedMessage(chatId, "ask_location", {
    reply_markup: {
      keyboard: [[{ text: keyboardText.location_share, request_location: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
}

async function homeMenu(chatId) {
  const keyboardText = await getTranslatedKeyboard(chatId);

  await sendTranslatedMessage(chatId, "home_menu", {
    reply_markup: {
      inline_keyboard: [
        [{ text: keyboardText.my_orders, callback_data: "my_orders" }],
        [{ text: keyboardText.change_language, callback_data: "change_language" }],
      ],
      resize_keyboard: false,
    },
  });
}

async function sendHomeMenuWithMessage(chatId, message, extra = {}) {
  const keyboardText = await getTranslatedKeyboard(chatId);

  const reply_markup = {
    inline_keyboard: [
      [{ text: keyboardText.my_orders, callback_data: "my_orders" }],
      [{ text: keyboardText.change_language, callback_data: "change_language" }],
    ],
    resize_keyboard: false,
  };

  if (extra.message_id) {
    try {
      await telegram.post("/editMessageText", {
        chat_id: chatId,
        message_id: extra.message_id,
        text: message,
        parse_mode: "HTML",
        reply_markup: reply_markup,
      });
    } catch (e) {
      console.log("Could not edit message, sending new message instead:", e.message || e);
      await sendMessage(chatId, message, { reply_markup });
    }
  } else {
    await sendMessage(chatId, message, { reply_markup });
  }
}

async function handleUpdate(req, res) {
  try {
    const update = req.body;
    console.log("Update received:", JSON.stringify(update, null, 2));

    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message.chat.id;
      const data = cq.data;
      const messageId = cq.message.message_id;

      await telegram.post("/answerCallbackQuery", {
        callback_query_id: cq.id,
      });

      console.log(`Processing callback query: ${data} from chatId: ${chatId}`);

      // Handle different callback queries
      if (data === "my_orders") {
        await deletePreviousOrderMessages(chatId);
        await sendCourierOrdersList(chatId);
        res.sendStatus(200);
        return;
      } else if (data === "change_language") {
        const currentLanguage = await getUserLanguage(chatId);
        const selectLangText = await translate(chatId, "select_language");
        const latinText = await translate(chatId, "Uzbek");
        const cyrillicText = await translate(chatId, "Krilcha");
        const russianText = await translate(chatId, "Ruscha");

        await sendMessage(chatId, selectLangText, {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: ` ${latinText}${currentLanguage === "uz" ? " " : ""}`,
                  callback_data: "lang_uz",
                },
              ],
              [
                {
                  text: ` ${cyrillicText}${currentLanguage === "uz_cyrl" ? " " : ""}`,
                  callback_data: "lang_uz_cyrl",
                },
              ],
              [
                {
                  text: ` ${russianText}${currentLanguage === "ru" ? " " : ""}`,
                  callback_data: "lang_ru",
                },
              ],
            ],
          },
        });
        res.sendStatus(200);
        return;
      } else if (data === "lang_uz") {
        await models.User.update({ language: "uz" }, { where: { chatId } });
        await changeLanguage("uz");
        try {
          await telegram.post("/deleteMessage", {
            chat_id: chatId,
            message_id: messageId,
          });
        } catch (e) {}
        await sendTranslatedMessage(chatId, "language_changed");
        await homeMenu(chatId);
        res.sendStatus(200);
        return;
      } else if (data === "lang_uz_cyrl") {
        await models.User.update({ language: "uz_cyrl" }, { where: { chatId } });
        await changeLanguage("uz_cyrl");
        try {
          await telegram.post("/deleteMessage", {
            chat_id: chatId,
            message_id: messageId,
          });
        } catch (e) {}
        await sendTranslatedMessage(chatId, "language_changed");
        await homeMenu(chatId);
        res.sendStatus(200);
        return;
      } else if (data === "lang_ru") {
        await models.User.update({ language: "ru" }, { where: { chatId } });
        await changeLanguage("ru");
        try {
          await telegram.post("/deleteMessage", {
            chat_id: chatId,
            message_id: messageId,
          });
        } catch (e) {}
        await sendTranslatedMessage(chatId, "language_changed");
        await homeMenu(chatId);
        res.sendStatus(200);
        return;
      } else if (data === "name_confirm_yes" || data === "name_confirm_no") {
        const state = userStateById.get(chatId) || {};
        try {
          await telegram.post("/deleteMessage", {
            chat_id: chatId,
            message_id: messageId,
          });
        } catch (e) {}

        if (data === "name_confirm_yes") {
          if (state.expected === "name_confirm" && state.userData?.fullName) {
            try {
              await models.User.update({ fullName: state.userData.fullName }, { where: { chatId } });
              await sendTranslatedMessage(chatId, "name_saved", {}, { fullName: state.userData.fullName });
            } catch (e) {
              await sendTranslatedMessage(chatId, "name_save_error");
            }
            state.expected = "phone";
            userStateById.set(chatId, state);
            await askPhone(chatId);
          }
        } else {
          state.expected = "full_name";
          userStateById.set(chatId, state);
          await sendTranslatedMessage(chatId, "ask_full_name");
        }
        res.sendStatus(200);
        return;
      } else if (data === "order_confirm_yes") {
        try {
          await telegram.post("/deleteMessage", {
            chat_id: chatId,
            message_id: messageId,
          });
        } catch (_) {}

        const keyboardText = await getTranslatedKeyboard(chatId);
        await sendMessage(chatId, await translate(chatId, "order_received"), {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[{ text: keyboardText.my_orders, callback_data: "my_orders" }]],
            resize_keyboard: false,
          },
        });
        res.sendStatus(200);
        return;
} else if (data.startsWith("order_confirm_yes:")) {
  const parts = data.split(":");
  const customerChatId = parts[1] ? parseInt(parts[1], 10) : null;
  const rawOrderId = parts[2] || null;
  let resolvedOrderNumber = rawOrderId && /^\d+$/.test(rawOrderId) ? parseInt(rawOrderId, 10) : null;

  try {
    await telegram.post("/deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    });
  } catch (e) {
    console.error("Failed to delete order confirmation message:", e.message || e);
  }

  const keyboardText = await getTranslatedKeyboard(chatId);
  await sendMessage(chatId, await translate(chatId, "order_received"), {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[{ text: keyboardText.my_orders, callback_data: "my_orders" }]],
      resize_keyboard: false,
    },
  });

  const messageText = cq.message?.text || "";
  let productName = "Sut";
  let liters = null;
  let latitude = null;
  let longitude = null;

  const productMatch = messageText.match(/ Mahsulot: (.+)/);
  if (productMatch) {
    productName = productMatch[1].trim();
  }
  const qtyMatch = messageText.match(/ Miqdor: ([\d.]+)L/);
  if (qtyMatch) {
    liters = parseFloat(qtyMatch[1]);
  }

  // Foydalanuvchi ma'lumotlarini olish
  let customer = null;
  let customerUserId = null;
  let customerPhone = null;
  let assignment = null;
  if (rawOrderId) {
    assignment =
      getOrderAssignment(rawOrderId) ||
      (resolvedOrderNumber ? getOrderAssignment(String(resolvedOrderNumber)) : null);
  }
  if (customerChatId) {
    const customerUser = await models.User.findOne({
      where: { chatId: customerChatId },
    });
    if (customerUser) {
      customer = {
        chatId: customerChatId,
        telegramId: customerUser.telegramId,
        id: customerUser.id,
        fullName: customerUser.fullName,
        username: customerUser.username,
        phone: customerUser.phone,
        latitude: customerUser.latitude,
        longitude: customerUser.longitude,
      };
      customerUserId = customerUser.id; // ← Lokal bazadagi ID (1)
      customerPhone = customerUser.phone; // ← Telefon raqam (+998905253101)
      
      if (customerUser.latitude && customerUser.longitude) {
        latitude = customerUser.latitude;
        longitude = customerUser.longitude;
      }
    }
  }

  // Fallback to assignment snapshot if DB lookup didn't provide values
  if (!customer && assignment?.customer) {
    customer = assignment.customer;
  }
  if (!customerUserId && assignment?.customer?.userId) {
    customerUserId = assignment.customer.userId;
  }
  if (!customerPhone && assignment?.customer?.phone) {
    customerPhone = assignment.customer.phone;
  }
  if ((latitude === null || longitude === null) && assignment?.customer) {
    if (assignment.customer.latitude) latitude = assignment.customer.latitude;
    if (assignment.customer.longitude) longitude = assignment.customer.longitude;
  }
  if (!customerPhone && customerChatId) {
    customerPhone = await getCustomerPhoneForApi(customerChatId);
  }

  if (
    (resolvedOrderNumber === null || Number.isNaN(resolvedOrderNumber)) &&
    assignment?.order
  ) {
    const assignmentOrderId =
      assignment.order.orderId ??
      assignment.order.externalId ??
      assignment.order.id ??
      null;
    const assignmentNumericId = toNumericId(assignmentOrderId);
    if (assignmentNumericId !== null) {
      resolvedOrderNumber = assignmentNumericId;
    }
  }

  // API dan buyurtmalarni olish - avval telefon raqam orqali
  let orderDetails = null;
  if (customerPhone && (!resolvedOrderNumber || Number.isNaN(resolvedOrderNumber))) {
    console.log("Fetching orders for phone:", customerPhone);
    const ordersResp = await getUserOrdersWithRetry(customerPhone, 2);
    console.log("Orders response from API:", ordersResp);
    
    if (ordersResp && ordersResp.success !== false) {
      const list = Array.isArray(ordersResp) 
        ? ordersResp 
        : ordersResp?.orders || ordersResp?.data || [];
      
      if (Array.isArray(list) && list.length > 0) {
        const pendingOrders = list
          .filter((o) => (o.status || "").toLowerCase() === "pending");
        
        const source = pendingOrders.length > 0 ? pendingOrders : list;
        console.log("Pending orders found:", pendingOrders.length, "total orders:", list.length);
        
        if (source.length > 0) {
          // Eng oxirgi (eng katta ID li) buyurtmani olish
          source.sort((a, b) => (b.id || 0) - (a.id || 0));
          resolvedOrderNumber = source[0].id;
          orderDetails = source[0];
          console.log("Selected order from API:", orderDetails);
        }
      }
    }
  }

  // Agar telefon raqam yoki userId bo'yicha topilmasa, chatId orqali urinib ko'ramiz
  if (
    !orderDetails &&
    (!resolvedOrderNumber || Number.isNaN(resolvedOrderNumber)) &&
    customerChatId
  ) {
    console.log("Trying to fetch orders by chatId (as userId):", customerChatId);
    const ordersResp = await getUserOrdersWithRetry(customerChatId, 2);
    console.log("Orders response from API by chatId:", ordersResp);

    if (ordersResp && ordersResp.success !== false) {
      const list = Array.isArray(ordersResp)
        ? ordersResp
        : ordersResp?.orders || ordersResp?.data || [];

      if (Array.isArray(list) && list.length > 0) {
        const pendingOrders = list.filter(
          (o) => (o.status || "").toLowerCase() === "pending"
        );

        const source = pendingOrders.length > 0 ? pendingOrders : list;

        if (source.length > 0) {
          source.sort((a, b) => (b.id || 0) - (a.id || 0));
          resolvedOrderNumber = source[0].id;
          orderDetails = source[0];
          console.log("Found order from API by chatId:", orderDetails);
        }
      }
    }
  }

  // Agar telefon raqam orqali topilmasa, userId orqali urinib ko'ramiz
  if (!orderDetails && customerUserId && (!resolvedOrderNumber || Number.isNaN(resolvedOrderNumber))) {
    console.log("Trying to fetch orders by userId:", customerUserId);
    const ordersResp = await getUserOrdersWithRetry(customerUserId, 1); // Faqat 1 marta urinish
    console.log("Orders response from API by userId:", ordersResp);
    
    if (ordersResp && ordersResp.success !== false) {
      const list = Array.isArray(ordersResp) 
        ? ordersResp 
        : ordersResp?.orders || ordersResp?.data || [];
      
      if (Array.isArray(list) && list.length > 0) {
        const pendingOrders = list
          .filter((o) => (o.status || "").toLowerCase() === "pending");
        
        const source = pendingOrders.length > 0 ? pendingOrders : list;
        
        if (source.length > 0) {
          source.sort((a, b) => (b.id || 0) - (a.id || 0));
          resolvedOrderNumber = source[0].id;
          orderDetails = source[0];
          console.log("Found order from API by userId:", orderDetails);
        }
      }
    }
  }

  if (orderDetails) {
    if (orderDetails.latitude && orderDetails.longitude) {
      latitude = orderDetails.latitude;
      longitude = orderDetails.longitude;
    }
    if (orderDetails.product?.name) {
      productName = orderDetails.product.name;
    }
    if (orderDetails.product?.items?.[0]?.quantity) {
      liters = Number(orderDetails.product.items[0].quantity);
    }
  }

  const normalizedOrderId =
    rawOrderId ||
    (resolvedOrderNumber !== null && !Number.isNaN(resolvedOrderNumber)
      ? String(resolvedOrderNumber)
      : null);

  // DEBUG: Barcha ma'lumotlarni chiqaramiz
  console.log("DEBUG - All collected data:", {
    customerChatId,
    customerUserId,
    customerPhone,
    resolvedOrderNumber,
    normalizedOrderId,
    orderDetails
  });

  const existingOrder =
    normalizedOrderId && customerChatId
      ? await models.CourierOrder.findOne({
          where: {
            courierChatId: chatId,
            orderId: normalizedOrderId,
            customerChatId: customerChatId,
          },
        })
      : null;

  if (!existingOrder && customer) {
    try {
      await createCourierOrderRecord({
        courierChatId: chatId,
        customer,
        order: orderDetails || {
          id: normalizedOrderId,
          status: "processing",
        },
        productName,
        liters,
        address: null,
      });
      console.log("Courier order record created successfully");
    } catch (error) {
      console.error("Failed to create courier order record:", error.message || error);
    }
  } else if (existingOrder) {
    await updateCourierOrderStatusLocal({
      courierChatId: chatId,
      customerChatId,
      orderId: normalizedOrderId,
      status: "processing",
    });
    console.log("Existing courier order updated");
  }

  // External API ga yangilash - faqat userId orqali
  const numericResolvedOrderId =
    toNumericId(resolvedOrderNumber) ?? toNumericId(normalizedOrderId);

  const externalUserIdRaw =
    (orderDetails && orderDetails.userId != null ? orderDetails.userId : null) ??
    (assignment && assignment.customer && assignment.customer.userId != null
      ? assignment.customer.userId
      : null) ??
    customerUserId;

  const numericExternalUserId = toNumericId(externalUserIdRaw);

  console.log("DEBUG - IDs for API update:", {
    customerUserId,
    customerPhone,
    resolvedOrderNumber,
    normalizedOrderId,
    numericResolvedOrderId,
    externalUserIdRaw,
    numericExternalUserId,
  });

  if (numericExternalUserId !== null && numericResolvedOrderId !== null) {
    try {
      console.log(
        `Updating order status via API with userId: ${numericExternalUserId}, orderId: ${numericResolvedOrderId}`
      );
      await updateOrderStatus(
        numericExternalUserId,
        numericResolvedOrderId,
        "processing"
      );
      console.log("Order status updated successfully in external API");
    } catch (error) {
      console.error("Failed to update order status in API:", error.message || error);
    }
  } else {
    console.warn("Cannot update order status - missing userId or orderId:", {
      customerUserId,
      customerPhone,
      resolvedOrderNumber,
      normalizedOrderId,
      numericResolvedOrderId,
      externalUserIdRaw,
      numericExternalUserId,
    });
  }

  if (normalizedOrderId) {
    markOrderAccepted(normalizedOrderId, chatId);
  }

  res.sendStatus(200);
  return;
} else if (data === "order_confirm_no") {
        try {
          await telegram.post("/deleteMessage", {
            chat_id: chatId,
            message_id: messageId,
          });
        } catch (_) {}

        await sendMessage(chatId, await translate(chatId, "order_cancelled"), {
          parse_mode: "HTML",
        });
        res.sendStatus(200);
        return;
      } else if (data.startsWith("order_confirm_no:")) {
        const parts = data.split(":");
        const customerChatId = parts[1] ? parseInt(parts[1], 10) : null;
        const rawOrderId = parts[2] || null;
        let resolvedOrderNumber =
          rawOrderId && /^\d+$/.test(rawOrderId)
            ? parseInt(rawOrderId, 10)
            : null;
        let externalUserId = null;

        try {
          await telegram.post("/deleteMessage", {
            chat_id: chatId,
            message_id: messageId,
          });
        } catch (e) {
          console.error("Failed to delete order confirmation message:", e.message || e);
        }

        await sendMessage(chatId, await translate(chatId, "order_cancelled"), {
          parse_mode: "HTML",
        });

        // Get customer phone for API calls
        let customerPhone = null;
        if (customerChatId) {
          customerPhone = await getCustomerPhoneForApi(customerChatId);
          console.log("Customer phone for cancellation:", customerPhone);
          
          if (customerPhone && (!resolvedOrderNumber || Number.isNaN(resolvedOrderNumber))) {
            const ordersResp = await getUserOrdersWithRetry(customerPhone, 2);
            console.log("Orders response for cancellation:", ordersResp);

            if (ordersResp && ordersResp.success !== false) {
              const list = Array.isArray(ordersResp)
                ? ordersResp
                : ordersResp?.orders || ordersResp?.data || [];

              if (Array.isArray(list) && list.length > 0) {
                const pendingSortedDesc = list
                  .filter((o) => (o.status || "").toLowerCase() === "pending")
                  .sort((a, b) => (a.id || 0) - (b.id || 0));
                if (pendingSortedDesc.length > 0) {
                  const selected = pendingSortedDesc[pendingSortedDesc.length - 1];
                  resolvedOrderNumber = selected.id;
                  externalUserId = selected.userId ?? null;
                }
              }
            }
          }
        }

        const normalizedOrderId =
          rawOrderId ||
          (resolvedOrderNumber !== null && !Number.isNaN(resolvedOrderNumber)
            ? String(resolvedOrderNumber)
            : null);

        await updateCourierOrderStatusLocal({
          courierChatId: chatId,
          customerChatId,
          orderId: normalizedOrderId,
          status: "cancelled",
        });

        // Extract productName and liters from message text for reassignment
        const messageText = cq.message?.text || "";
        let productName = "Sut";
        let liters = null;
        
        const productMatch = messageText.match(/ Mahsulot: (.+)/);
        if (productMatch) {
          productName = productMatch[1].trim();
        }
        const qtyMatch = messageText.match(/ Miqdor: ([\d.]+)L/);
        if (qtyMatch) {
          liters = parseFloat(qtyMatch[1]);
        }

        let reassigned = false;
        if (normalizedOrderId && customerChatId) {
          try {
            const nextCourier = await getNextCourierForOrder(normalizedOrderId);
            if (nextCourier && nextCourier.chatId) {
              const nextContext = {
                customerChatId: customerChatId,
                productName: productName || "Sut",
                liters: liters,
                customerAddress: null,
              };
              await notifySellerAboutOrder({
                sellerChatId: nextCourier.chatId,
                customerChatId: nextCourier.customerChatId || customerChatId,
                orderId: normalizedOrderId,
                productName: nextContext.productName,
                liters: nextContext.liters,
                address: nextContext.customerAddress,
              });
              reassigned = true;
            }
          } catch (err) {
            console.error("Failed to forward order to next courier:", err.message || err);
          }
        }

        if (!reassigned) {
          const numericResolvedOrderId = toNumericId(resolvedOrderNumber);
          const numericExternalUserId = toNumericId(externalUserId);

          if (numericExternalUserId !== null && numericResolvedOrderId !== null) {
            try {
              console.log(
                `Updating order status via API (cancelled) with userId: ${numericExternalUserId}, orderId: ${numericResolvedOrderId}`
              );
              await updateOrderStatus(
                numericExternalUserId,
                numericResolvedOrderId,
                "cancelled"
              );
            } catch (e) {
              console.error(
                "Failed to update order status to cancelled:",
                e.message || e
              );
            }
          } else {
            console.warn(
              "Cannot update order status to cancelled - missing userId or orderId:",
              {
                externalUserId,
                resolvedOrderNumber,
              }
            );
          }

          if (normalizedOrderId) {
            clearOrderAssignment(normalizedOrderId);
          }
        }

        res.sendStatus(200);
        return;
      } else if (data === "confirm_yes") {
        try {
          await telegram.post("/deleteMessage", {
            chat_id: chatId,
            message_id: messageId,
          });
        } catch (e) {
          console.error("Failed to delete confirmation message:", e.message || e);
        }

        userStateById.set(chatId, {});
        await sendTranslatedMessage(chatId, "registration_complete");
        await homeMenu(chatId);
        res.sendStatus(200);
        return;
      } else if (data === "confirm_no") {
        try {
          await telegram.post("/deleteMessage", {
            chat_id: chatId,
            message_id: messageId,
          });
        } catch (e) {
          console.error("Failed to delete confirmation message:", e.message || e);
        }

        const state = userStateById.get(chatId) || {};
        state.expected = "full_name";
        userStateById.set(chatId, state);
        await sendTranslatedMessage(chatId, "ask_full_name");
        res.sendStatus(200);
        return;
      } else if (data.startsWith("back_to_home_menu:")) {
        const msgId = parseInt(data.split(":")[1], 10);
        await sendHomeMenuWithMessage(chatId, await translate(chatId, "back_to_home"), {
          message_id: msgId,
        });
        userStateById.delete(chatId);
        res.sendStatus(200);
        return;
      } else if (data.startsWith("courier_order_view:")) {
        const parts = data.split(":");
        const orderDbId = parseInt(parts[1], 10);
        const ordersListMessageId = cq.message.message_id;
        await sendCourierOrderDetails(chatId, orderDbId, ordersListMessageId);
        res.sendStatus(200);
        return;
      } else if (data.startsWith("order_delivered:")) {
        const parts = data.split(":");
        const orderDbId = parseInt(parts[1], 10);
        const ordersListMessageId = parts[2] ? parseInt(parts[2], 10) : null;
        const messageId = cq.message.message_id;

        try {
          const order = await models.CourierOrder.findByPk(orderDbId);
          if (order) {
            const plainOrder = typeof order.get === "function" ? order.get({ plain: true }) : order;
            let externalOrderId = plainOrder.orderId || plainOrder.externalOrderId || null;

            // Get customer phone for API calls
            let customerPhone = null;
            const customerChatId = resolveCustomerChatId(plainOrder) || plainOrder.customerChatId;
            const assignmentSnapshot = externalOrderId
              ? getOrderAssignment(String(externalOrderId))
              : null;
            if (customerChatId) {
              customerPhone = await getCustomerPhoneForApi(customerChatId);
              console.log("Customer phone for delivery:", customerPhone);
              if (!customerPhone) {
                const numericChatId = toNumericId(customerChatId);
                if (numericChatId && numericChatId !== customerChatId) {
                  customerPhone = await getCustomerPhoneForApi(numericChatId);
                  console.log("Customer phone retry with numeric chatId:", customerPhone);
                }
              }
              // If it's a temporary ID, try to get the real order ID from the API
              if (externalOrderId && externalOrderId.startsWith("tmp-") && customerPhone) {
                console.log("Found temporary order ID, fetching real order ID from API...");

                try {
                  const ordersResp = await getUserOrdersWithRetry(customerPhone, 2);
                  console.log("Orders response for delivery:", ordersResp);

                  if (ordersResp && ordersResp.success !== false) {
                    const ordersList = Array.isArray(ordersResp)
                      ? ordersResp
                      : ordersResp?.data || [];

                    // Find the most recent processing order for this customer
                    const processingOrders = ordersList.filter(
                      (o) => o.status === "processing"
                    );
                    if (processingOrders.length > 0) {
                      processingOrders.sort((a, b) => b.id - a.id);
                      externalOrderId = String(processingOrders[0].id);
                      console.log("Found real order ID from API:", externalOrderId);
                    }
                  }
                } catch (apiError) {
                  console.error("Failed to fetch orders from API:", apiError.message || apiError);
                }
              }
            }
            if (!customerPhone) {
              customerPhone =
                plainOrder.phone ||
                plainOrder?.payload?.customer?.phone ||
                plainOrder?.payload?.order?.customer?.phone ||
                assignmentSnapshot?.customer?.phone ||
                null;
            }
            if (!customerPhone && plainOrder?.customerUserId) {
              try {
                const customerRecord = await models.User.findOne({
                  where: { id: plainOrder.customerUserId },
                  attributes: ["phone"],
                  raw: true,
                });
                customerPhone = customerRecord?.phone || customerPhone;
              } catch (lookupErr) {
                console.error("Failed to fetch customer phone by userId:", lookupErr.message || lookupErr);
              }
            }

            // Determine which userId to use for external status API
            let externalUserId = null;
            if (plainOrder?.payload?.order?.userId != null) {
              // Prefer userId that came from the status API / external order payload
              externalUserId = plainOrder.payload.order.userId;
            } else if (assignmentSnapshot?.customer?.userId != null) {
              // Fallback to userId stored in the assignment snapshot
              externalUserId = assignmentSnapshot.customer.userId;
            } else if (plainOrder.customerUserId != null) {
              // Finally, fallback to the customerUserId stored on the courier order
              externalUserId = plainOrder.customerUserId;
            }

            const numericExternalUserId = toNumericId(externalUserId);

            const numericExternalOrderId = toNumericId(externalOrderId);

            console.log(
              "Final IDs - externalOrderId:",
              externalOrderId,
              "numericExternalOrderId:",
              numericExternalOrderId,
              "externalUserId:",
              externalUserId,
              "numericExternalUserId:",
              numericExternalUserId,
              "customerPhone:",
              customerPhone
            );

            // Update order status to completed in our database
            await models.CourierOrder.update(
              {
                status: "completed",
                orderId: externalOrderId,
              },
              { where: { id: orderDbId } }
            );

            // Get courier's phone number
            let sellerPhone = null;
            try {
              const currentUser = await models.User.findOne({
                where: { chatId: chatId },
                attributes: ["phone"],
                raw: true,
              });
              sellerPhone = currentUser?.phone;
              console.log("Seller phone found:", sellerPhone);
            } catch (e) {
              console.error("Failed to fetch current user's phone:", e.message || e);
            }

            // Update external API using correct userId
            if (
              numericExternalUserId !== null &&
              numericExternalOrderId !== null
            ) {
              try {
                console.log(
                  `Updating order status for userId: ${numericExternalUserId}, order: ${numericExternalOrderId}`
                );
                await updateOrderStatus(
                  numericExternalUserId,
                  numericExternalOrderId,
                  "completed",
                  sellerPhone
                );
                console.log("Order status updated successfully in external API");
              } catch (e) {
                console.error(
                  "Failed to update order status in external API:",
                  e.message || e
                );
              }
            } else {
              console.warn(
                "Cannot update order status - missing userId or orderId:",
                {
                  externalUserId,
                  numericExternalUserId,
                  externalOrderId,
                  numericExternalOrderId,
                }
              );
            }

            // Clear assignment
            if (externalOrderId) {
              clearOrderAssignment(String(externalOrderId));
            }

            // Delete the current message
            try {
              await telegram.post("/deleteMessage", {
                chat_id: chatId,
                message_id: messageId,
              });
            } catch (e) {
              console.log("Could not delete message:", e.message || e);
            }

            // Remove this message ID from state
            const state = userStateById.get(chatId) || {};
            if (state.orderMessages) {
              state.orderMessages = state.orderMessages.filter((id) => id !== messageId);
              userStateById.set(chatId, state);
            }

            await telegram.post("/answerCallbackQuery", {
              callback_query_id: cq.id,
              text: await translate(chatId, "order_delivered"),
            });
          }
        } catch (error) {
          console.error("Failed to update order status:", error.message || error);
          await telegram.post("/answerCallbackQuery", {
            callback_query_id: cq.id,
            text: await translate(chatId, "error"),
          });
        }

        res.sendStatus(200);
        return;
      } else if (data.startsWith("order_not_delivered:")) {
        const messageId = cq.message.message_id;

        try {
          await telegram.post("/deleteMessage", {
            chat_id: chatId,
            message_id: messageId,
          });
        } catch (e) {
          console.log("Could not delete message:", e.message || e);
        }

        const state = userStateById.get(chatId) || {};
        if (state.orderMessages) {
          state.orderMessages = state.orderMessages.filter((id) => id !== messageId);
          userStateById.set(chatId, state);
        }

        await sendTranslatedMessage(chatId, "order_not_delivered");
        res.sendStatus(200);
        return;
      } else if (data.startsWith("courier_orders_page:")) {
        const page = parseInt(data.split(":")[1], 10) || 1;
        const messageId = cq.message.message_id;
        const state = userStateById.get(chatId) || {};
        state.ordersListMessageId = messageId;
        userStateById.set(chatId, state);
        await sendCourierOrdersList(chatId);
        res.sendStatus(200);
        return;
      } else if (data.startsWith("courier_orders_back:")) {
        const detailMessageId = cq.message.message_id;
        try {
          await telegram.post("/deleteMessage", {
            chat_id: chatId,
            message_id: detailMessageId,
          });
        } catch (e) {
          console.error("Failed to delete detail message:", e.message || e);
        }
        res.sendStatus(200);
        return;
      } else if (data === "courier_detail_close") {
        const detailMessageId = cq.message.message_id;
        try {
          await telegram.post("/deleteMessage", {
            chat_id: chatId,
            message_id: detailMessageId,
          });
        } catch (e) {
          console.error("Failed to delete detail message:", e.message || e);
        }
        res.sendStatus(200);
        return;
      } else if (data === "courier_orders_close") {
        const listMessageId = cq.message.message_id;
        try {
          await telegram.post("/deleteMessage", {
            chat_id: chatId,
            message_id: listMessageId,
          });
        } catch (e) {
          console.error("Failed to delete orders list message:", e.message || e);
        }
        const st = userStateById.get(chatId) || {};
        if (st.ordersListMessageId) {
          delete st.ordersListMessageId;
          userStateById.set(chatId, st);
        }
        res.sendStatus(200);
        return;
      }

      res.sendStatus(200);
      return;
    }

    const message = update && (update.message || update.edited_message);
    if (message && message.chat) {
      const chatId = message.chat.id;
      const text = typeof message.text === "string" ? message.text.trim() : "";

      if (text === "/orders" || text === "Buyurtmalarim" || text.includes("Buyurtmalarim")) {
        await deletePreviousOrderMessages(chatId);
        await sendCourierOrdersList(chatId);
        res.sendStatus(200);
        return;
      }

      if (text === "/language" || text.includes("Tilni o'zgartirish")) {
        await sendTranslatedMessage(chatId, "select_language", {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: " O'zbek (Lotin)",
                  callback_data: "lang_uz",
                },
              ],
              [
                {
                  text: " Ўзбек (Кирилл)",
                  callback_data: "lang_uz_cyrl",
                },
              ],
            ],
          },
        });
        res.sendStatus(200);
        return;
      }

      const state = userStateById.get(chatId) || {};

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

        await sendTranslatedMessage(
          chatId,
          "user_info",
          {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: await translate(chatId, "yes"), callback_data: "confirm_yes" },
                  { text: await translate(chatId, "no"), callback_data: "confirm_no" },
                ],
              ],
            },
          },
          {
            username: uname,
            fullName: fullName,
            phone: phone,
            address: address,
          }
        );
        res.sendStatus(200);
        return;
      }

      if (state.expected === "full_name" && text) {
        // Agar foydalanuvchi ism o'rniga buyruq yuborsa (masalan, /start),
        // uni fullName sifatida qabul qilmaymiz va ismni qaytadan so'raymiz.
        if (text.startsWith("/")) {
          await sendTranslatedMessage(chatId, "ask_full_name");
          res.sendStatus(200);
          return;
        }

        state.userData = state.userData || {};
        state.userData.fullName = text.trim();
        state.expected = "name_confirm";
        userStateById.set(chatId, state);

        await sendTranslatedMessage(
          chatId,
          "confirm_name",
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: await translate(chatId, "yes"), callback_data: "name_confirm_yes" }],
                [{ text: await translate(chatId, "no"), callback_data: "name_confirm_no" }],
              ],
            },
          },
          { fullName: state.userData.fullName }
        );
        res.sendStatus(200);
        return;
      }

      if (state.expected === "name_confirm" && text === "Ha") {
        try {
          await models.User.update({ fullName: state.userData.fullName }, { where: { chatId } });
          await sendTranslatedMessage(chatId, "name_saved", {}, { fullName: state.userData.fullName });
          state.expected = "phone";
          userStateById.set(chatId, state);
          await askPhone(chatId);
        } catch (e) {
          console.error("Failed to save user name:", e);
          await sendTranslatedMessage(chatId, "name_save_error");
        }
        res.sendStatus(200);
        return;
      }

      if (state.expected === "name_confirm" && text === "Yo'q") {
        state.expected = "full_name";
        userStateById.set(chatId, state);
        await sendTranslatedMessage(chatId, "ask_full_name");
        res.sendStatus(200);
        return;
      }

      if (message.contact && message.contact.phone_number && state.expected === "phone") {
        const phone = message.contact.phone_number;
        state.expected = "location";
        userStateById.set(chatId, state);

        try {
          await models.User.update({ phone }, { where: { chatId } });
          await sendTranslatedMessage(chatId, "phone_saved", {}, { phone: phone });
          await askLocation(chatId);
        } catch (e) {
          console.error("Failed to save phone:", e);
          await sendTranslatedMessage(chatId, "phone_save_error");
        }
        res.sendStatus(200);
        return;
      }

      if (text === "/start" || text.startsWith("/start")) {
        const from = message.from || {};
        const telegramId = from.id;
        const username = from.username || null;

        try {
          const existingUser = await models.User.findOne({
            where: { telegramId },
          });

          const hasCompletedRegistration =
            existingUser &&
            existingUser.fullName &&
            existingUser.phone &&
            (existingUser.address || (existingUser.latitude && existingUser.longitude));

          if (hasCompletedRegistration) {
            const keyboardText = await getTranslatedKeyboard(chatId);
            await sendTranslatedMessage(
              chatId,
              "login_success",
              {
                reply_markup: {
                  inline_keyboard: [
                    [{ text: keyboardText.my_orders, callback_data: "my_orders" }],
                    [{ text: keyboardText.change_language, callback_data: "change_language" }],
                  ],
                  resize_keyboard: false,
                },
              },
              {
                telegramId: existingUser.telegramId,
                phone: existingUser.phone || "—",
                fullName: existingUser.fullName || "—",
              }
            );
            res.sendStatus(200);
            return;
          }

          if (existingUser) {
            let nextStep = "";

            if (!existingUser.fullName) {
              nextStep = "full_name";
              userStateById.set(chatId, {
                expected: "full_name",
                userData: { telegramId, chatId, username },
              });
              await sendTranslatedMessage(chatId, "ask_full_name");
            } else if (!existingUser.phone) {
              nextStep = "phone";
              userStateById.set(chatId, {
                expected: "phone",
                userData: { telegramId, chatId, username },
              });
              await askPhone(chatId);
            } else if (!existingUser.address && !(existingUser.latitude && existingUser.longitude)) {
              nextStep = "location";
              userStateById.set(chatId, {
                expected: "location",
                userData: { telegramId, chatId, username },
              });
              await askLocation(chatId);
            }

            if (nextStep) {
              res.sendStatus(200);
              return;
            }
          }

          if (!existingUser) {
            await models.User.create({
              telegramId,
              chatId,
              username,
              language: "uz",
            });

            userStateById.set(chatId, {
              expected: "full_name",
              userData: { telegramId, chatId, username },
            });
          }

          await sendTranslatedMessage(chatId, "welcome");

          if (!existingUser) {
            await sendTranslatedMessage(chatId, "ask_full_name");
          }

          res.sendStatus(200);
          return;
        } catch (e) {
          console.error("Sequelize start handler failed:", e.message || e);
          await sendTranslatedMessage(chatId, "start_error");
          res.sendStatus(200);
          return;
        }
      }

      if (text === "/help") {
        await sendTranslatedMessage(chatId, "help");
        res.sendStatus(200);
        return;
      }

      if (text) {
        await sendTranslatedMessage(chatId, "unknown_command");
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
  notifySellerAboutOrder,
  deletePreviousOrderMessages,
};