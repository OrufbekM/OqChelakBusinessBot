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
} = require("../verification.controller");
const axios = require("axios");
const { inlineKeyboard } = require("telegraf/markup");

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const STATUS_API_BASE =
  process.env.STATUS_API_BASE ||
  "https://zymogenic-edmond-lamellately.ngrok-free.dev";

const userStateById = new Map();

const ORDER_STATUS_EMOJI = {
  pending: "⏳",
  processing: "🚚",
  completed: "✅",
  cancelled: "❌",
};

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

  // If it's a pure number, use it directly
  if (/^\d+$/.test(str)) {
    const num = Number(str);
    return Number.isFinite(num) ? num : null;
  }

  return null;
}

// Format phone number to +998 format
function formatPhoneNumber(phone) {
  if (!phone) return null;
  
  // Remove all non-digit characters
  const cleaned = phone.replace(/\D/g, '');
  
  // If it's 9 digits, add +998 prefix
  if (cleaned.length === 9 && /^[9]\d{8}$/.test(cleaned)) {
    return '+998' + cleaned;
  }
  
  // If it's 12 digits and starts with 998, add + prefix
  if (cleaned.length === 12 && /^998\d{9}$/.test(cleaned)) {
    return '+' + cleaned;
  }
  
  // If it's 13 digits and starts with +998, return as is
  if (cleaned.length === 13 && /^\+998\d{9}$/.test(phone)) {
    return phone;
  }
  
  // If it doesn't match any pattern, return null
  return null;
}

// Validate phone number
function isValidPhoneNumber(phone) {
  return formatPhoneNumber(phone) !== null;
}

// Build order notification text with geocoded address and maps link
async function buildOrderNotificationText(
  customerChatId,
  productName,
  liters,
  opts = {}
) {
  let address = "—";
  let lat;
  let lon;
  let mapsUrl = "";
  const name = productName || "Milk";
  const qty = liters ? `${liters}L` : "—";

  try {
    const user = await models.User.findOne({
      where: { chatId: customerChatId },
    });
    lat = typeof opts.latitude === "number" ? opts.latitude : user?.latitude;
    lon = typeof opts.longitude === "number" ? opts.longitude : user?.longitude;

    if (typeof lat === "number" && typeof lon === "number") {
      const detailed = await reverseGeocodeDetailed(lat, lon);
      const formatted = detailed?.address
        ? formatUzAddress(detailed.address)
        : null;
      address =
        formatted || (await reverseGeocode(lat, lon)) || `${lat}, ${lon}`;
      mapsUrl = `https://maps.google.com/?q=${lat},${lon}`;
    }
  } catch (e) {
    console.error("buildOrderNotificationText failed:", e.message || e);
  }

  locationText = `<a href="${escapeHtml(mapsUrl)}">Ko'rish uchun bosing</a>`;

  return (
    `📦 Mahsulot xabari\n\n` +
    `📦 Mahsulot: ${name}\n` +
    `📏 Miqdor: ${qty}\n` +
    `📍 Manzili: ${address}\n` +
    `🗺️ Lokatsiya: ${locationText}\n\n` +
    `Buyurtmani qabul qilasizmi?`
  );
}

// Send order request to seller with inline confirm/cancel buttons
async function notifySellerAboutOrder({
  sellerChatId,
  customerChatId,
  orderId,
  productName = "Milk",
  liters,
  latitude,
  longitude,
}) {
  const text = await buildOrderNotificationText(
    customerChatId,
    productName,
    liters,
    {
      latitude,
      longitude,
    }
  );
  const inline_keyboard = [
    [
      {
        text: "Ha ✅",
        callback_data: `order_confirm_yes:${customerChatId}:${orderId || ""}`,
      },
      {
        text: "Yo'q ❌",
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
    const customerId =
      resolveCustomerChatId(order) || order.customerChatId || "";
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

function formatCourierOrderForMessage(order, showQuestion = true) {
  const productName = escapeHtml(order.productName || "—");
  const liters =
    order.liters !== null && order.liters !== undefined
      ? escapeHtml(`${order.liters}`)
      : "—";
  const address = escapeHtml(order.address || "—");
  const phone = escapeHtml(order.phone || "—");
  const customerName = escapeHtml(order.customerName || "—");
  const orderNameLine = `📦 Buyurtma nomi: ${productName}`;
  const litersLine = `🥛 Litr: ${liters}`;
  const addressLine = `📍 Manzil: ${address}`;
  const phoneLine = `📞 Telefon: ${phone}`;
  const customerLine = `👤 Mijoz: ${customerName}`;
  let locationLine = "🗺️ Lokatsiya: —";
  const mapsUrl =
    order.mapsUrl ||
    (order.latitude && order.longitude
      ? `https://maps.google.com/?q=${order.latitude},${order.longitude}`
      : null);
  if (mapsUrl) {
    locationLine = `🗺️ Lokatsiya: <a href="${escapeHtml(
      mapsUrl
    )}">Ko'rish uchun bosing</a>`;
  }

  const parts = [
    orderNameLine,
    litersLine,
    addressLine,
    locationLine,
    phoneLine,
    customerLine,
  ];

  if (showQuestion) {
    parts.push(`\nBuyurtma Yetkazildimi?`);
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

// Send each order as a separate message without pagination
async function sendCourierOrdersList(chatId) {
  try {
    const allOrders = await getCourierOrdersByChatId(chatId);

    if (!allOrders || allOrders.length === 0) {
      await sendMessage(chatId, "Sizda buyurtmalar topilmadi.");
      return;
    }

    const seenKeys = new Set();
    const uniqueOrders = [];
    for (const order of allOrders) {
      const key = getCourierOrderUniqueKey(order);
      if (key && seenKeys.has(key)) {
        continue;
      }
      if (key) {
        seenKeys.add(key);
      }
      uniqueOrders.push(order);
    }

    // Send each order as a separate message
    for (const order of uniqueOrders) {
      const orderText = formatCourierOrderForMessage(order, order.status !== "completed");
      
      // Build inline keyboard for each order
      const inline_keyboard = [];
      
      if (order.status !== "completed") {
        inline_keyboard.push([
          {
            text: "Yetkazildi ✅",
            callback_data: `order_delivered:${order.id}`,
          },
          {
            text: "Yetkazilmadi ❌",
            callback_data: `order_not_delivered:${order.id}`,
          },
        ]);
      }

      await sendMessage(chatId, orderText, {
        reply_markup: { inline_keyboard }
      });
    }

  } catch (e) {
    console.error("sendCourierOrdersList failed:", e.message || e);
    await sendMessage(chatId, "Buyurtmalarni ko'rsatishda xatolik yuz berdi.");
  }
}

async function sendCourierOrderDetails(
  chatId,
  orderId,
  ordersListMessageId = null
) {
  try {
    const order = await models.CourierOrder.findByPk(orderId);

    if (!order) {
      await sendMessage(chatId, "Buyurtma topilmadi.");
      return;
    }

    // Get global order number
    const allOrders = await getCourierOrdersByChatId(chatId);
    const orderIndex = allOrders.findIndex((o) => o.id === orderId);
    const orderNumber =
      orderIndex !== -1
        ? `${orderIndex + 1}. ${order.productName || "Mahsulot"} ${
            order.liters ? `${order.liters}L` : ""
          }`
        : "";

    // Format order details
    const orderText = formatCourierOrderForMessage(
      order,
      order.status !== "completed"
    );
    const fullText = orderNumber ? `${orderNumber}\n\n${orderText}` : orderText;

    // Build inline keyboard
    const inline_keyboard = [];

    // Accept/Decline buttons (only if not completed)
    if (order.status !== "completed") {
      inline_keyboard.push([
        {
          text: "Ha ✅",
          callback_data: `order_delivered:${order.id}:${
            ordersListMessageId || ""
          }`,
        },
        {
          text: "Yo'q ❌",
          callback_data: `order_not_delivered:${order.id}:${
            ordersListMessageId || ""
          }`,
        },
      ]);
    }

    // Back button to return to list (also serves as close)
    inline_keyboard.push([
      {
        text: "Orqaga ↩️",
        callback_data: `courier_orders_back:${ordersListMessageId || ""}`,
      },
    ]);

    const replyMarkup = {
      inline_keyboard: inline_keyboard,
    };

    await sendMessage(chatId, fullText, { reply_markup: replyMarkup });
  } catch (e) {
    console.error("sendCourierOrderDetails failed:", e.message || e);
    await sendMessage(
      chatId,
      "Buyurtma ma'lumotlarini ko'rsatishda xatolik yuz berdi."
    );
  }
}

async function updateCourierOrderStatusLocal({
  courierChatId,
  customerChatId,
  orderId,
  status,
}) {
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

async function getUserOrders(userId) {
  try {
    const url = `${STATUS_API_BASE}/api/status?userId=${encodeURIComponent(
      userId
    )}`;
    const { data } = await axios.get(url, { timeout: 15000 });
    return data;
  } catch (e) {
    console.error("getUserOrders failed:", e.response?.data || e.message || e);
    return null;
  }
}

async function updateOrderStatus(userId, orderId, status, courierPhone = null) {
  try {
    const url = `${STATUS_API_BASE}/api/status/user/${encodeURIComponent(
      userId
    )}/order/${encodeURIComponent(orderId)}`;

    // Prepare the update data
    const updateData = { status };

    // If status is completed and we have a courier phone number, include it in the update
    if (status === "completed" && courierPhone) {
      updateData.phoneNumber = courierPhone;

      // Also send to the specified webhook URL
      try {
        await axios.post(
          "https://zymogenic-edmond-lamellately.ngrok-free.dev/api/status/seller/info/",
          {
            orderId,
            phoneNumber: courierPhone,
          },
          {
            timeout: 10000,
            headers: { "Content-Type": "application/json" },
          }
        );
      } catch (webhookError) {
        console.error(
          "Failed to send courier phone to webhook:",
          webhookError.message || webhookError
        );
        // Don't fail the whole operation if webhook fails
      }
    }

    const { data } = await axios.put(url, updateData, {
      timeout: 15000,
      headers: { "Content-Type": "application/json" },
    });
    return data;
  } catch (e) {
    console.error(
      "updateOrderStatus failed:",
      e.response?.data || e.message || e
    );
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
    console.log("sendMessage ok:", resp.data);
    return resp.data.result.message_id;
  } catch (err) {
    console.error(
      "sendMessage failed:",
      err.response?.data || err.message || err
    );
  }
}

async function askPhone(chatId) {
  await sendMessage(chatId, "Iltimos, raqamingizni ulashing yoki raqamni kiriting (masalan: 909993394):", {
    reply_markup: {
      keyboard: [[{ text: "Raqamni ulashish 📱", request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
}

async function askLocation(chatId) {
  await sendMessage(chatId, "Iltimos, manzilingizni ulashing: ", {
    reply_markup: {
      keyboard: [
        [{ text: "Manzilni ulashish 📍", request_location: true }],
      ],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
}

async function homeMenu(chatId) {
  await sendMessage(chatId, "Bosh sahifa:", {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Buyurtmalarim 📑", callback_data: 'my_orders' },
          { text: "Tilni o'zgartirish 🌐", callback_data: 'change_language' }
        ]
      ],
      resize_keyboard: true,
    },
  });
}

async function sendHomeMenuWithMessage(chatId, message, extra = {}) {
  const reply_markup = {
    inline_keyboard: [
      [
        { text: "Buyurtmalarim 📑", callback_data: 'my_orders' },
        { text: "Tilni o'zgartirish 🌐", callback_data: 'change_language' }
      ]
    ]
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
      console.log(
        "Could not edit message, sending new message instead:",
        e.message || e
      );
      await sendMessage(chatId, message, { reply_markup });
    }
  } else {
    await sendMessage(chatId, message, { reply_markup });
  }
}

async function handleUpdate(req, res) {
  try {
    const update = req.body;
    console.log("Update received:", JSON.stringify(update));

    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message.chat.id;
      const data = cq.data;
      const messageId = cq.message.message_id;

      // Answer the callback query to remove the loading state
      await telegram.post("/answerCallbackQuery", {
        callback_query_id: cq.id,
      });

      if (data === "my_orders") {
        await sendCourierOrdersList(chatId);
        res.sendStatus(200);
        return;

      } else if (data === "change_language") {
        await sendMessage(chatId, "🌐 Tilni tanlang:", {
          reply_markup: {
            inline_keyboard: [
              [{
                text: "🇺🇿 O'zbek (Lotin)",
                callback_data: "lang_uz_latn"
              }],
              [{
                text: "🇺🇿 Ўзбек (Кирилл)",
                callback_data: "lang_uz_cyrl"
              }]
            ]
          }
        });
        res.sendStatus(200);
        return;
      } else if (data === "lang_uz_latn") {
        await sendMessage(chatId, "Til muvaffaqiyatli o'zgartirildi!");
        res.sendStatus(200);
        return;
      } else if (data === "lang_uz_cyrl") {
        await sendMessage(chatId, "Тил муваффақиятли ўзгартирилди!");
        res.sendStatus(200);
        return;
      } else if (data === "confirm_yes") {
        userStateById.set(chatId, {});
        await sendHomeMenuWithMessage(chatId, "Ma'lumotlar tasdiqlandi ✅: \n\nBosh sahifa:");
        res.sendStatus(200);
        return;
      } else if (data === "order_confirm_yes") {
        res.sendStatus(200);
        return;
      } else if (data.startsWith("order_confirm_yes:")) {
        const parts = data.split(":");
        const customerChatId = parts[1] ? parseInt(parts[1], 10) : null;
        const rawOrderId = parts[2] || null;
        let resolvedOrderNumber =
          rawOrderId && /^\d+$/.test(rawOrderId)
            ? parseInt(rawOrderId, 10)
            : null;
        const confirmationMessageId = cq.message.message_id;


        // Edit seller's inline message - ADD BUYURTMALARIM BUTTON
        await telegram.post("/editMessageText", {
          chat_id: chatId,
          message_id: confirmationMessageId,
          text: "Buyurtma qabul qilindi ✅",
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Buyurtmalarim 📑",
                  callback_data: "my_orders"
                }
              ]
            ]
          },
        });

        // Get order details from message text
        const messageText = cq.message?.text || "";
        let productName = "Sut";
        let liters = null;
        let latitude = null;
        let longitude = null;

        // Parse product name and liters from message
        const productMatch = messageText.match(/📦 Mahsulot: (.+)/);
        if (productMatch) {
          productName = productMatch[1].trim();
        }
        const qtyMatch = messageText.match(/📏 Miqdor: ([\d.]+)L/);
        if (qtyMatch) {
          liters = parseFloat(qtyMatch[1]);
        }

        // Fallback: if orderId is missing/invalid, pick the most recent pending order
        let orderDetails = null;
        if (
          customerChatId &&
          (!resolvedOrderNumber || Number.isNaN(resolvedOrderNumber))
        ) {
          const ordersResp = await getUserOrders(customerChatId);
          const list = Array.isArray(ordersResp)
            ? ordersResp
            : ordersResp?.orders || ordersResp?.data || [];
          if (Array.isArray(list) && list.length > 0) {
            const pendingSortedDesc = list
              .filter((o) => (o.status || "").toLowerCase() === "pending")
              .sort((a, b) => (b.id || 0) - (a.id || 0));
            if (pendingSortedDesc.length > 0) {
              resolvedOrderNumber = pendingSortedDesc[0].id;
              orderDetails = pendingSortedDesc[0];
            }
          }
        }

        // Get customer information
        let customer = null;
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
            // Use customer coordinates if available
            if (customerUser.latitude && customerUser.longitude) {
              latitude = customerUser.latitude;
              longitude = customerUser.longitude;
            }
          }
        }

        // If order details from API, use those coordinates
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

        // Check if order already exists in CourierOrder
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
          // Create new CourierOrder record ONLY if it doesn't exist
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
              address: null, // Will be resolved by createCourierOrderRecord
            });
          } catch (error) {
            console.error(
              "Failed to create courier order record:",
              error.message || error
            );
          }
        } else if (existingOrder) {
          // Update existing order status
          await updateCourierOrderStatusLocal({
            courierChatId: chatId,
            customerChatId,
            orderId: normalizedOrderId,
            status: "processing",
          });
        }

        // Accept -> set processing in external API (only if numeric order id available)
        const numericResolvedOrderId =
          toNumericId(resolvedOrderNumber) ?? toNumericId(normalizedOrderId);
        if (customerChatId && numericResolvedOrderId !== null) {
          try {
            await updateOrderStatus(
              customerChatId,
              numericResolvedOrderId,
              "processing"
            );
          } catch (_) {}
        }

        if (normalizedOrderId) {
          markOrderAccepted(normalizedOrderId, chatId);
        }
      } else if (data === "order_confirm_no") {
        // legacy no-op: ignore bare cancel without identifiers
      } else if (data.startsWith("order_confirm_no:")) {
        const parts = data.split(":");
        const customerChatId = parts[1] ? parseInt(parts[1], 10) : null;
        const rawOrderId = parts[2] || null;
        let resolvedOrderNumber =
          rawOrderId && /^\d+$/.test(rawOrderId)
            ? parseInt(rawOrderId, 10)
            : null;
        const confirmationMessageId = cq.message.message_id;
        
        // Edit seller's inline message - ADD BUYURTMALARIM BUTTON
        await telegram.post("/editMessageText", {
          chat_id: chatId,
          message_id: confirmationMessageId,
          text: "Buyurtma bekor qilindi ❌",
          parse_mode: "HTML",
        });
        
        if (
          customerChatId &&
          (!resolvedOrderNumber || Number.isNaN(resolvedOrderNumber))
        ) {
          const ordersResp = await getUserOrders(customerChatId);
          const list = Array.isArray(ordersResp)
            ? ordersResp
            : ordersResp?.orders || ordersResp?.data || [];
          if (Array.isArray(list) && list.length > 0) {
            const pendingSortedDesc = list
              .filter((o) => (o.status || "").toLowerCase() === "pending")
              .sort((a, b) => (b.id || 0) - (a.id || 0));
            if (pendingSortedDesc.length > 0) {
              resolvedOrderNumber = pendingSortedDesc[0].id;
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

        let reassigned = false;
        if (normalizedOrderId) {
          const nextCourier = getNextCourierForOrder(normalizedOrderId, chatId);
          const nextCourierChatId = nextCourier?.candidate?.courier?.chatId;
          if (nextCourier && nextCourierChatId) {
            try {
              const nextContext = nextCourier.context || {};
              const targetCustomer = nextContext.customer || {};
              const nextCustomerChatId =
                targetCustomer.chatId ||
                targetCustomer.telegramId ||
                targetCustomer.id ||
                customerChatId;
              await notifySellerAboutOrder({
                sellerChatId: nextCourierChatId,
                customerChatId: nextCustomerChatId,
                orderId: normalizedOrderId,
                productName: nextContext.productName || "Sut",
                liters: nextContext.liters,
                latitude: targetCustomer.latitude,
                longitude: targetCustomer.longitude,
              });

              await createCourierOrderRecord({
                courierChatId: nextCourierChatId,
                customer: targetCustomer,
                order: nextContext.order,
                productName: nextContext.productName,
                liters: nextContext.liters,
                address: nextContext.customerAddress,
              });

              await sendMessage(
                chatId,
                "Rahmat! Buyurtma boshqa kuryerga yuborildi 🚚"
              );
              reassigned = true;
            } catch (err) {
              console.error(
                "Failed to forward order to next courier:",
                err.message || err
              );
            }
          }
        }

        if (!reassigned) {
          if (
            customerChatId &&
            resolvedOrderNumber &&
            !Number.isNaN(resolvedOrderNumber)
          ) {
            try {
              await updateOrderStatus(
                customerChatId,
                resolvedOrderNumber,
                "cancelled"
              );
            } catch (e) {
              await sendMessage(
                chatId,
                `Status yangilashda xatolik ❌ (userId=${customerChatId}, orderId=${resolvedOrderNumber}): cancelled`
              );
            }
          } 

          if (normalizedOrderId) {
            clearOrderAssignment(normalizedOrderId);
          }
        }
      } else if (data === "confirm_no") {
        await sendMessage(
          chatId,
          "Bekor qilindi. /start bilan qayta boshlang.",
          {
            reply_markup: { remove_keyboard: true },
          }
        );
      } else if (data.startsWith("back_to_home_menu:")) {
        const messageId = parseInt(data.split(":")[1], 10);
        await sendHomeMenuWithMessage(chatId, "Bosh menyu ↩️", {
          message_id: messageId,
        });
        userStateById.delete(chatId);
      } else if (data.startsWith("courier_order_view:")) {
        // View specific order details
        const parts = data.split(":");
        const orderDbId = parseInt(parts[1], 10);
        const ordersListMessageId = cq.message.message_id; // Store the list message ID
        await sendCourierOrderDetails(chatId, orderDbId, ordersListMessageId);
      } else if (data.startsWith("order_delivered:")) {
        const parts = data.split(":");
        const orderDbId = parseInt(parts[1], 10);
        const ordersListMessageId = parts[2] ? parseInt(parts[2], 10) : null;
        const messageId = cq.message.message_id;

        try {
          const order = await models.CourierOrder.findByPk(orderDbId);
          if (order) {
            const plainOrder =
              typeof order.get === "function"
                ? order.get({ plain: true })
                : order;

            console.log("Processing order delivery for orderDbId:", orderDbId);
            console.log(
              "Plain order data:",
              JSON.stringify(plainOrder, null, 2)
            );

            // GET THE ACTUAL ORDER ID
            let externalOrderId =
              plainOrder.orderId || plainOrder.externalOrderId || null;

            // If it's a temporary ID, try to get the real order ID from the API
            if (externalOrderId && externalOrderId.startsWith("tmp-")) {
              console.log(
                "Found temporary order ID, fetching real order ID from API..."
              );

              const customerChatId =
                resolveCustomerChatId(plainOrder) || plainOrder.customerChatId;
              if (customerChatId) {
                try {
                  const ordersResp = await getUserOrders(customerChatId);
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
                    console.log(
                      "Found real order ID from API:",
                      externalOrderId
                    );
                  }
                } catch (apiError) {
                  console.error(
                    "Failed to fetch orders from API:",
                    apiError.message || apiError
                  );
                }
              }
            }

            const externalUserId =
              resolveCustomerChatId(plainOrder) || plainOrder.customerChatId;
            const numericExternalOrderId = toNumericId(externalOrderId);

            console.log(
              "Final IDs - externalOrderId:",
              externalOrderId,
              "numericExternalOrderId:",
              numericExternalOrderId,
              "externalUserId:",
              externalUserId
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
              console.error(
                "Failed to fetch current user's phone:",
                e.message || e
              );
            }

            // Update external API - Order status to completed USING PUT METHOD
            if (externalUserId && numericExternalOrderId !== null) {
              try {
                console.log(
                  `Making PUT request to: https://zymogenic-edmond-lamellately.ngrok-free.dev/api/status/user/${externalUserId}/order/${numericExternalOrderId}`
                );
                console.log("Request body:", { status: "completed" });

                const statusResponse = await axios.put(
                  `https://zymogenic-edmond-lamellately.ngrok-free.dev/api/status/user/${externalUserId}/order/${numericExternalOrderId}`,
                  {
                    status: "completed",
                  },
                  {
                    headers: {
                      "Content-Type": "application/json",
                    },
                    timeout: 10000,
                  }
                );
                console.log(
                  "✅ Order status update API response:",
                  JSON.stringify(statusResponse.data, null, 2)
                );

                // Check if the update was successful
                if (
                  statusResponse.data &&
                  statusResponse.data.status === "completed"
                ) {
                  console.log(
                    "✅ SUCCESS: Order status changed to completed in API"
                  );
                } else {
                  console.log(
                    "❌ API response doesn't show completed status:",
                    statusResponse.data
                  );
                }
              } catch (e) {
                console.error(
                  "❌ Failed to update order status in external API:",
                  e.message || e
                );
                if (e.response) {
                  console.error("API response error data:", e.response.data);
                  console.error("API response status:", e.response.status);
                  console.error("API response headers:", e.response.headers);
                }
              }
            } else {
              console.warn(
                "❌ Cannot update order status - missing externalUserId or numericExternalOrderId:",
                {
                  externalUserId: externalUserId,
                  numericExternalOrderId: numericExternalOrderId,
                }
              );
            }

            // Send seller info USING POST METHOD
            if (numericExternalOrderId !== null && sellerPhone) {
              try {
                console.log(
                  `Making POST request to seller info endpoint for order: ${numericExternalOrderId}`
                );
                console.log("Seller info request body:", {
                  orderId: numericExternalOrderId,
                  phoneNumber: sellerPhone,
                });

                const sellerResponse = await axios.post(
                  "https://zymogenic-edmond-lamellately.ngrok-free.dev/api/status/seller/info/",
                  {
                    orderId: numericExternalOrderId,
                    phoneNumber: sellerPhone,
                  },
                  {
                    headers: {
                      "Content-Type": "application/json",
                    },
                    timeout: 10000,
                  }
                );
                console.log(
                  "✅ Seller info sent successfully:",
                  sellerResponse.data
                );
              } catch (apiError) {
                console.error(
                  "❌ Failed to send seller info to API:",
                  apiError.message || apiError
                );
                if (apiError.response) {
                  console.error(
                    "Seller API response error:",
                    apiError.response.data
                  );
                }
              }
            } else {
              console.warn(
                "❌ Cannot send seller info - missing orderId or phone:",
                {
                  orderId: numericExternalOrderId,
                  sellerPhone: sellerPhone,
                }
              );
            }

            // Clear assignment
            if (externalOrderId) {
              clearOrderAssignment(String(externalOrderId));
            }

            // Update the message
            const allOrders = await getCourierOrdersByChatId(chatId);
            const orderIndex = allOrders.findIndex((o) => o.id === orderDbId);
            const orderNumber =
              orderIndex !== -1
                ? `${orderIndex + 1}. ${plainOrder.productName || "Mahsulot"} ${
                    plainOrder.liters ? `${plainOrder.liters}L` : ""
                  }`
                : "";
            const completedOrder = {
              ...plainOrder,
              status: "completed",
              orderId: externalOrderId,
            };
            const orderText = formatCourierOrderForMessage(
              completedOrder,
              false
            );
            const fullText = orderNumber
              ? `${orderNumber}\n\n${orderText}`
              : orderText;

            await telegram.post("/editMessageText", {
              chat_id: chatId,
              message_id: messageId,
              text: fullText,
              parse_mode: "HTML",
              
            });

            await telegram.post("/answerCallbackQuery", {
              callback_query_id: cq.id,
              text: "Buyurtma yetkazilgan deb belgilandi ✅",
            });
          }
        } catch (error) {
          console.error(
            "Failed to update order status:",
            error.message || error
          );
          await telegram.post("/answerCallbackQuery", {
            callback_query_id: cq.id,
            text: "Xatolik yuz berdi. Iltimos, qayta urinib ko'ring.",
          });
        }

        if (res) res.sendStatus(200);
        return;
      } else if (data.startsWith("order_not_delivered:")) {
        // Courier reported "No" - keep status and send a reminder
        await sendMessage(
          chatId,
          "Iltimos, buyurtmani tezroq yetkazib bering 📦"
        );
      } else if (data.startsWith("courier_orders_page:")) {
        // Pagination - change page in orders list (edit existing message)
        const page = parseInt(data.split(":")[1], 10) || 1;
        const messageId = cq.message.message_id;
        // Store messageId in state for future use
        const state = userStateById.get(chatId) || {};
        state.ordersListMessageId = messageId;
        userStateById.set(chatId, state);
        await sendCourierOrdersList(chatId, page, messageId);
      } else if (data.startsWith("courier_orders_back:")) {
        // Back - delete detail message only
        const detailMessageId = cq.message.message_id;

        // Delete the detail message
        try {
          await telegram.post("/deleteMessage", {
            chat_id: chatId,
            message_id: detailMessageId,
          });
        } catch (e) {
          console.error("Failed to delete detail message:", e.message || e);
        }
      } else if (data === "courier_detail_close") {
        // Delete the currently opened detail message
        const detailMessageId = cq.message.message_id;
        try {
          await telegram.post("/deleteMessage", {
            chat_id: chatId,
            message_id: detailMessageId,
          });
        } catch (e) {
          console.error("Failed to delete detail message:", e.message || e);
        }
      } else if (data === "courier_orders_close") {
        // Close the orders list message and clear state
        const listMessageId = cq.message.message_id;
        try {
          await telegram.post("/deleteMessage", {
            chat_id: chatId,
            message_id: listMessageId,
          });
        } catch (e) {
          console.error(
            "Failed to delete orders list message:",
            e.message || e
          );
        }
        const st = userStateById.get(chatId) || {};
        if (st.ordersListMessageId) {
          delete st.ordersListMessageId;
          userStateById.set(chatId, st);
        }
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

      // Keep the old text commands for backward compatibility
      if (
        text === "/orders" ||
        text === "Buyurtmalarim 📑" ||
        text === "Buyurtmalarim" ||
        text === "Buyurtmalarim🗒️"
      ) {
        const state = userStateById.get(chatId) || {};
        await sendCourierOrdersList(
          chatId,
          1,
          state.ordersListMessageId || null
        );
        res.sendStatus(200);
        return;
      }
      if (
        text === "/language" ||
        text === "Tilni o'zgartirish 🌐" ||
        text === "Tilni o'zgartirish" ||
        text === "🌐 Tilni o'zgartirish"
      ) {
        await sendMessage(chatId, "🌐 Tilni tanlang:", {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "🇺🇿 O'zbek (Lotin)",
                  callback_data: "lang_uz_latn",
                },
              ],
              [
                {
                  text: "🇺🇿 Ўзбек (Кирилл)",
                  callback_data: "lang_uz_cyrl",
                },
              ],
            ],
          },
        });
      } 

      let responseJson = null

      if (text === "🇺🇿 O'zbek (Lotin)") {
        responseJson = {
        chatId,
        language: "uz_lat",
        message: "Til muvaffaqiyatli o'zgartirildi!"
        };
        } else if (text === "🇺🇿 Ўзбек (Кирилл)") {
        responseJson = {
        chatId,
        language: "uz_cyr",
        message: "Тил муваффақиятли ўзгартирилди!"
        };
        }
        
        if (responseJson) {
        console.log(responseJson); 
        await sendMessage(chatId, responseJson.message, { sendHomeMenuWithMessage });
        res.sendStatus(200);
        return;
        }

      // Handle location input as text
      const state = userStateById.get(chatId) || {};
      if (state.expected === "location_text" && text) {
        try {
          // Save the text address
          await models.User.update(
            {
              address: text,
              currentLocation: "text",
            },
            { where: { chatId } }
          );

          const user = await models.User.findOne({ where: { chatId } });
          const uname = user?.username ? `@${user.username}` : "—";
          const fullName = user?.fullName || "—";
          const phone = user?.phone || "—";
          const address = user?.address || "—";

          await sendMessage(
            chatId,
            `Ma'lumotlaringiz:\nUsername: ${uname}\nFull name: ${fullName}\nTelefon: ${phone}\nManzil: ${address}\n\nMa'lumotlar to'g'rimi?`,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: "Ha ✅", callback_data: "confirm_yes" },
                    { text: "Yo'q ❌", callback_data: "confirm_no" },
                  ],
                ],
              },
            }
          );
          
          state.expected = null;
          userStateById.set(chatId, state);
        } catch (e) {
          console.error("Failed to save text address:", e);
          await sendMessage(chatId, "Manzilni saqlashda xatolik yuz berdi. Iltimos, qaytadan urinib ko'ring.");
        }
        res.sendStatus(200);
        return;
      }

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
          const detailed = await reverseGeocodeDetailed(
            user.latitude,
            user.longitude
          );
          const formatted =
            detailed && detailed.address
              ? formatUzAddress(detailed.address)
              : null;
          if (formatted) {
            address = formatted;
          } else {
            const fallback = await reverseGeocode(
              user.latitude,
              user.longitude
            );
            address = fallback || `${user.latitude}, ${user.longitude}`;
          }
        }

        await sendMessage(
          chatId,
          `Ma'lumotlaringiz:\nUsername: ${uname}\nFull name: ${fullName}\nTelefon: ${phone}\nManzil: ${address}\n\nMa'lumotlar to'g'rimi?`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "Ha ✅", callback_data: "confirm_yes" },
                  { text: "Yo'q ❌", callback_data: "confirm_no" },
                ],
              ],
            },
          }
        );
        res.sendStatus(200);
        return;
      }

      // Handle phone number input as text
      if (state.expected === "phone" && text) {
        let phone = text.trim();
        
        // Format phone number
        const formattedPhone = formatPhoneNumber(phone);
        
        if (!formattedPhone) {
          await sendMessage(
            chatId,
            "Iltimos, to'g'ri telefon raqam kiriting (masalan: 909993394) yoki 'Raqamni ulashish' tugmasini bosing."
          );
          res.sendStatus(200);
          return;
        }

        state.expected = "location";
        userStateById.set(chatId, state);

        try {
          await models.User.update(
            { phone: formattedPhone },
            { where: { chatId } }
          );
          await sendMessage(chatId, `Rahmat! Raqamingiz qabul qilindi: ${formattedPhone} ✅`);
          await askLocation(chatId);
        } catch (e) {
          console.error("Failed to save phone:", e);
          await sendMessage(chatId, "Telefon raqamingizni saqlashda xatolik yuz berdi. Iltimos, qaytadan urinib ko'ring.");
        }
        res.sendStatus(200);
        return;
      }

      // Handle first name input
      if (state.expected === "first_name" && text) {
        state.userData = state.userData || {};
        state.userData.firstName = text.trim();
        state.expected = "last_name";
        userStateById.set(chatId, state);
        
        await sendMessage(chatId, "Familiyangizni kiriting:");
        res.sendStatus(200);
        return;
      }

      // Handle last name input
      if (state.expected === "last_name" && text) {
        state.userData.lastName = text.trim();
        state.expected = "phone";
        userStateById.set(chatId, state);
        
        // Update user with full name
        const fullName = `${state.userData.firstName} ${state.userData.lastName}`.trim();
        try {
          await models.User.update(
            { fullName },
            { where: { chatId } }
          );
          await sendMessage(chatId, `Ism-familiyangiz saqlandi: ${fullName}`);
          await askPhone(chatId);
        } catch (e) {
          console.error("Failed to save user name:", e);
          await sendMessage(chatId, "Xatolik yuz berdi. Iltimos, qaytadan urinib ko'ring.");
        }
        res.sendStatus(200);
        return;
      }

      // Handle phone number input via contact
      if (message.contact && message.contact.phone_number && state.expected === "phone") {
        const phone = message.contact.phone_number;
        state.expected = "location";
        userStateById.set(chatId, state);

        try {
          await models.User.update(
            { phone },
            { where: { chatId } }
          );
          await sendMessage(chatId, "Rahmat! Raqamingiz qabul qilindi ✅");
          await askLocation(chatId);
        } catch (e) {
          console.error("Failed to save phone:", e);
          await sendMessage(chatId, "Telefon raqamingizni saqlashda xatolik yuz berdi. Iltimos, qaytadan urinib ko'ring.");
        }
        res.sendStatus(200);
        return;
      }

      // Handle "Manzilni yozish" button
      if (text === "Manzilni yozish ✍️") {
        state.expected = "location_text";
        userStateById.set(chatId, state);
        await sendMessage(chatId, "Iltimos, manzilingizni to'liq matn shaklida yuboring:");
        res.sendStatus(200);
        return;
      }

      if (text === "Orqaga qaytish ↩️" || text === "Orqaga ↩️") {
        await sendHomeMenuWithMessage(chatId, "O'zgarishlar yo'q🤷‍♂️");
        userStateById.delete(chatId);
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
      
          // Check if user has completed all required registration steps
          const hasCompletedRegistration = existingUser && 
                                         existingUser.fullName && 
                                         existingUser.phone && 
                                         (existingUser.address || (existingUser.latitude && existingUser.longitude));
      
          if (hasCompletedRegistration) {
            await sendMessage(
              chatId,
              `Hisobga kirildi✅:\n\n` +
                `🆔ID: ${existingUser.telegramId}\n` +
                `📞Telefon raqamingiz: ${existingUser.phone || "—"}\n` +
                `👤Ismingiz: ${existingUser.fullName || "—"}`,
              {
                reply_markup: {
                  inline_keyboard: [
                    [
                      { text: "Buyurtmalarim 📑", callback_data: 'my_orders' },
                      { text: "Tilni o'zgartirish 🌐", callback_data: 'change_language' }
                    ]
                  ]
                },
              }
            );
            res.sendStatus(200);
            return;
          }
      
          // If user exists but registration is incomplete, continue from where they left off
          if (existingUser) {
            let nextStep = "";
            
            if (!existingUser.fullName) {
              nextStep = "first_name";
              userStateById.set(chatId, { 
                expected: "first_name",
                userData: { telegramId, chatId, username }
              });
              await sendMessage(chatId, `Ro'yhatdan o'tishni davom ettiramiz. Iltimos, ismingizni kiriting:`);
            } else if (!existingUser.phone) {
              nextStep = "phone";
              userStateById.set(chatId, { 
                expected: "phone",
                userData: { telegramId, chatId, username }
              });
              await askPhone(chatId);
            } else if (!existingUser.address && !(existingUser.latitude && existingUser.longitude)) {
              nextStep = "location";
              userStateById.set(chatId, { 
                expected: "location",
                userData: { telegramId, chatId, username }
              });
              await askLocation(chatId);
            }
      
            if (nextStep) {
              res.sendStatus(200);
              return;
            }
          }
      
          // If no existing user or something went wrong, create new user
          if (!existingUser) {
            const newUser = await models.User.create({
              telegramId,
              chatId,
              username,
            });
      
            userStateById.set(chatId, { 
              expected: "first_name",
              userData: { telegramId, chatId, username }
            });
          }
      
          await sendMessage(
            chatId,
            `Oq Chelack Business ga hush kelibsiz! Ro'yhatdan o'tish uchun quyidagi ma'lumotlarni kiriting.\n\nIltimos, ismingizni kiriting:`
          );
          res.sendStatus(200);
          return;
          
        } catch (e) {
          console.error("Sequelize start handler failed:", e.message || e);
          await sendMessage(
            chatId,
            "Xatolik yuz berdi. Keyinroq urinib ko'ring."
          );
          res.sendStatus(200);
          return;
        }
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
  notifySellerAboutOrder,
};