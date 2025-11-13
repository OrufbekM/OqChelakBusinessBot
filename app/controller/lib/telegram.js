require("dotenv").config();

const { telegram } = require("./axios");
const models = require("../../models");
const {
  reverseGeocode,
  reverseGeocodeDetailed,
  formatUzAddress,
} = require("../../utils/geocode");

const BOT_TOKEN = process.env.BOT_TOKEN || "";

const userStateById = new Map();
const PAGE_SIZE = 3;

function formatUzDate(dt) {
  try {
    const d = new Date(dt);
    const day = d.getDate();
    const months = [
      "yanvar",
      "fevral",
      "mart",
      "aprel",
      "may",
      "iyun",
      "iyul",
      "avgust",
      "sentyabr",
      "oktyabr",
      "noyabr",
      "dekabr",
    ];
    const month = months[d.getMonth()] || "";
    const year = d.getFullYear();
    return `${day}-${month} ${year}`;
  } catch (_) {
    return "";
  }
}

function getWebhookPath() {
  if (process.env.WEBHOOK_PATH) return process.env.WEBHOOK_PATH;
  return BOT_TOKEN ? `/webhook/${BOT_TOKEN}` : `/webhook`;
}

function formatPriceWithComma(price) {
  return price.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

async function showProducts(chatId, page = 1) {
  try {
    const limit = PAGE_SIZE;
    const where = { chatId };
    const count = await models.Product.count({ where });
    if (!count) {
      await sendMessage(chatId, "Mahsulotlar ro'yxati bo'sh...");
      return;
    }

    const totalPages = Math.max(1, Math.ceil(count / limit));
    const p = Math.max(1, Math.min(parseInt(page, 10) || 1, totalPages));
    const offset = (p - 1) * limit;

    const rows = await models.Product.findAll({
      where,
      limit,
      offset,
      order: [["createdAt", "DESC"]],
    });

    const text =
      rows
        .map(
          (pr, idx) =>
            `${idx + 1}. Sut\n` +
            `Narxi: ${formatPriceWithComma(pr.productPrice)} som\n` +
            `Hajmi: ${pr.productSize} litr\n` +
            `Qo'shilgan: ${formatUzDate(pr.createdAt)}`
        )
        .join("\n\n") + `\n\nSahifa: ${p}/${totalPages}`;

    const inline_keyboard = [
      [
        { text: "Tahrirlash✏️", callback_data: `edit:${rows[0].id}` },
        { text: "Ochirish🗑️", callback_data: `delete:${rows[0].id}` },
      ],
    ];

    const nav = [];
    if (p > 1)
      nav.push({ text: "◀️ Oldingi", callback_data: `plist:${p - 1}` });
    if (p < totalPages)
      nav.push({ text: "Keyingi ▶️", callback_data: `plist:${p + 1}` });
    if (nav.length) inline_keyboard.push(nav);

    await sendMessage(chatId, text, { reply_markup: { inline_keyboard } });
  } catch (e) {
    console.error("showProducts failed:", e.message || e);
    await sendMessage(chatId, "Maxsulotlarni ko'rsatishda xatolik yuz berdi.");
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

async function askProduct(chatId) {
  await sendMessage(chatId, "Odatda qancha litr sut sotasiz?", {
    reply_markup: {
      keyboard: [
        [{ text: "5 litr" }, { text: "10 litr" }, { text: "15 litr" }],
        [{ text: "Boshqa" }],
        [{ text: "Orqaga qaytish ↩️" }],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  });
}

async function askPrice(chatId) {
  await sendMessage(chatId, "1 litr sut uchun narxni kiriting 💵", {
    reply_markup: {
      keyboard: [
        [
          { text: "10,000 som" },
          { text: "12,000 som" },
          { text: "16,000 som" },
        ],
        [{ text: "O'zim narx belgilayman" }],
        [{ text: "Orqaga qaytish ↩️" }],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  });
}

async function homeMenu(chatId) {
  await sendMessage(chatId, "Bosh sahifa:", {
    reply_markup: {
      keyboard: [
        [{ text: "Maxsulot qo'shish ➕" }],
        [{ text: "Maxsulotlarimni korish👁️" }],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  });
}

async function showEditProductsMenu(chatId) {
  try {
    const products = await models.Product.findAll({
      where: { chatId },
      order: [["createdAt", "DESC"]],
    });

    if (!products.length) {
      await sendMessage(chatId, "Mahsulotlar ro'yxati bo'sh...");
      await homeMenu(chatId);
      return;
    }

    const keyboard = products.map((product, index) => [
      {
        text: `${index + 1}. Sut ${
          product.productSize
        }L, ${formatPriceWithComma(product.productPrice)} som`,
      },
    ]);

    keyboard.push([{ text: "Orqaga ↩️" }]);

    await sendMessage(chatId, "Tahrirlash uchun mahsulotni tanlang:", {
      reply_markup: {
        keyboard: keyboard,
        resize_keyboard: true,
        one_time_keyboard: false,
      },
    });
  } catch (e) {
    console.error("showEditProductsMenu failed:", e.message || e);
    await sendMessage(chatId, "Xatolik yuz berdi.");
  }
}

async function showDeleteProductsMenu(chatId) {
  try {
    const products = await models.Product.findAll({
      where: { chatId },
      order: [["createdAt", "DESC"]],
    });

    if (!products.length) {
      await sendMessage(chatId, "Mahsulotlar ro'yxati bo'sh...");
      await homeMenu(chatId);
      return;
    }

    const keyboard = products.map((product, index) => [
      {
        text: `${index + 1}. Sut ${
          product.productSize
        }L, ${formatPriceWithComma(product.productPrice)} som`,
      },
    ]);

    keyboard.push([{ text: "Orqaga ↩️" }]);

    await sendMessage(chatId, "O'chirish uchun mahsulotni tanlang:", {
      reply_markup: {
        keyboard: keyboard,
        resize_keyboard: true,
        one_time_keyboard: false,
      },
    });
  } catch (e) {
    console.error("showDeleteProductsMenu failed:", e.message || e);
    await sendMessage(chatId, "Xatolik yuz berdi.");
  }
}

async function showProductEditOptions(chatId, productId) {
  const product = await models.Product.findByPk(productId);
  if (!product) {
    await sendMessage(chatId, "Mahsulot topilmadi.");
    return;
  }

  await sendMessage(
    chatId,
    `Tanlangan mahsulot:\nSut ${product.productSize}L, ${formatPriceWithComma(
      product.productPrice
    )} som\n\nNimani o'zgartirmoqchisiz?`,
    {
      reply_markup: {
        keyboard: [
          [{ text: `Hajmni o'zgartirish (${product.productSize}L)` }],
          [
            {
              text: `Narxni o'zgartirish (${formatPriceWithComma(
                product.productPrice
              )} som)`,
            },
          ],
          [{ text: "Orqaga ↩️" }],
        ],
        resize_keyboard: true,
        one_time_keyboard: false,
      },
    }
  );
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
        await sendMessage(
          chatId,
          "Sut mahsulotlarini qayergacha yetkazib bera olasiz?",
          {
            reply_markup: {
              keyboard: [
                [{ text: "2 km" }, { text: "4 km" }],
                [{ text: "6 km" }, { text: "8 km" }],
                [{ text: "Boshqa" }, { text: "Hamma joyga" }],
              ],
              resize_keyboard: true,
              one_time_keyboard: false,
            },
          }
        );
      } else if (data === "add_product") {
        userStateById.set(chatId, { expected: "product_size" });
        await askProduct(chatId);
      } else if (data === "confirm_no") {
        await sendMessage(
          chatId,
          "Bekor qilindi. /start bilan qayta boshlang.",
          {
            reply_markup: { remove_keyboard: true },
          }
        );
      } else if (data === "prod_confirm_yes") {
        const st = userStateById.get(chatId) || {};
        const productSize = st.productSize;
        const productPrice = st.productPrice;
        try {
          if (productSize && productPrice) {
            await models.Product.create({
              chatId,
              productName: "Sut",
              productSize,
              productPrice,
            });
            await homeMenu(chatId);
          } else {
            await sendMessage(chatId, "Xatolik: ma'lumotlar to'liq emas.");
          }
        } catch (e) {
          console.error("Sequelize save (product) failed:", e.message || e);
          await sendMessage(
            chatId,
            "Xatolik yuz berdi. Keyinroq urinib ko'ring."
          );
        }
        userStateById.delete(chatId);
      } else if (data === "prod_confirm_no") {
        userStateById.set(chatId, {});
        await homeMenu(chatId);
      } else if (data.startsWith("plist:")) {
        const page = parseInt(data.split(":")[1], 10);
        await showProducts(chatId, page);
      } else if (data.startsWith("edit:")) {
        const productId = parseInt(data.split(":")[1], 10);
        await showEditProductsMenu(chatId);
        userStateById.set(chatId, {
          expected: "edit_product_selection",
          productId,
        });
      } else if (data.startsWith("delete:")) {
        const productId = parseInt(data.split(":")[1], 10);
        await showDeleteProductsMenu(chatId);
        userStateById.set(chatId, {
          expected: "delete_product_selection",
          productId,
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

      if (message.contact && message.contact.phone_number) {
        const st = userStateById.get(chatId) || {};
        st.phone = message.contact.phone_number;
        st.expected = "location";
        userStateById.set(chatId, st);

        try {
          await models.User.update({ phone: st.phone }, { where: { chatId } });
        } catch (e) {
          console.error("Sequelize update (phone) failed:", e.message || e);
        }

        await sendMessage(chatId, "Rahmat! Raqamingiz qabul qilindi ✅");
        await askLocation(chatId);
        res.sendStatus(200);
        return;
      }

      const state = userStateById.get(chatId) || {};

      if (text === "Orqaga qaytish ↩️" || text === "Orqaga ↩️") {
        if (state.expected && state.expected.includes("edit")) {
          await homeMenu(chatId);
          userStateById.delete(chatId);
        } else {
          await homeMenu(chatId);
        }
        res.sendStatus(200);
        return;
      }

      if (state.expected === "edit_product_selection") {
        const products = await models.Product.findAll({
          where: { chatId },
          order: [["createdAt", "DESC"]],
        });

        const selectedIndex = parseInt(text.split(".")[0], 10) - 1;

        if (selectedIndex >= 0 && selectedIndex < products.length) {
          const selectedProduct = products[selectedIndex];
          await showProductEditOptions(chatId, selectedProduct.id);
          userStateById.set(chatId, {
            expected: "edit_product_option",
            productId: selectedProduct.id,
          });
        }
        res.sendStatus(200);
        return;
      }

      if (state.expected === "delete_product_selection") {
        const products = await models.Product.findAll({
          where: { chatId },
          order: [["createdAt", "DESC"]],
        });

        const selectedIndex = parseInt(text.split(".")[0], 10) - 1;

        if (selectedIndex >= 0 && selectedIndex < products.length) {
          const selectedProduct = products[selectedIndex];
          await models.Product.destroy({ where: { id: selectedProduct.id } });
          await sendMessage(chatId, "Maxsulot o'chirildi ✅");
          await showProducts(chatId, 1);
          userStateById.delete(chatId);
        }
        res.sendStatus(200);
        return;
      }

      if (state.expected === "edit_product_option") {
        const productId = state.productId;
        const product = await models.Product.findByPk(productId);

        if (!product) {
          await sendMessage(chatId, "Mahsulot topilmadi.");
          userStateById.delete(chatId);
          await homeMenu(chatId);
          res.sendStatus(200);
          return;
        }

        if (text.includes("Hajmni o'zgartirish")) {
          userStateById.set(chatId, {
            expected: "edit_product_size",
            productId,
          });
          await sendMessage(chatId, "Yangi hajmini kiriting (litrda):", {
            reply_markup: {
              keyboard: [
                [{ text: "5 litr" }, { text: "10 litr" }],
                [{ text: "15 litr" }, { text: "Boshqa" }],
                [{ text: "Orqaga ↩️" }],
              ],
              resize_keyboard: true,
            },
          });
        } else if (text.includes("Narxni o'zgartirish")) {
          userStateById.set(chatId, {
            expected: "edit_product_price",
            productId,
          });
          await sendMessage(chatId, "Yangi narxni kiriting:", {
            reply_markup: {
              keyboard: [
                [{ text: "10,000 som" }, { text: "12,000 som" }],
                [{ text: "16,000 som" }, { text: "Boshqa narx" }],
                [{ text: "Orqaga ↩️" }],
              ],
              resize_keyboard: true,
            },
          });
        }
        res.sendStatus(200);
        return;
      }

      if (state.expected === "edit_product_size") {
        const productId = state.productId;
        let newSize;

        if (text === "Boshqa") {
          await sendMessage(chatId, "Yangi hajmini kiriting (masalan: 7):");
          res.sendStatus(200);
          return;
        }

        const m = text.match(/^(\d+)\s*l/i);
        if (m) {
          newSize = parseInt(m[1], 10);
        } else if (/^\d+$/.test(text)) {
          newSize = parseInt(text, 10);
        }

        if (newSize && newSize > 0) {
          await models.Product.update(
            { productSize: newSize },
            { where: { id: productId } }
          );
          await sendMessage(chatId, "Mahsulot hajmi yangilandi ✅");
          userStateById.delete(chatId);
          await homeMenu(chatId);
        } else {
          await sendMessage(
            chatId,
            "Iltimos, to'g'ri hajm kiriting (masalan: 7)"
          );
        }
        res.sendStatus(200);
        return;
      }

      if (state.expected === "edit_product_price") {
        const productId = state.productId;
        let newPrice;

        if (text === "Boshqa narx") {
          await sendMessage(
            chatId,
            "Yangi narxni kiriting (masalan: 10,000 som):"
          );
          res.sendStatus(200);
          return;
        }

        const m = text.match(/^\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\s*som)?\s*$/i);
        if (m) {
          const normalized = m[1].replace(/,/g, "");
          newPrice = parseInt(normalized, 10);
        }

        if (newPrice && newPrice > 0) {
          if (newPrice > 17000) {
            await sendMessage(
              chatId,
              "Narx 17,000 somdan yuqori bo'lishi mumkin emas"
            );
            res.sendStatus(200);
            return;
          }

          await models.Product.update(
            { productPrice: newPrice },
            { where: { id: productId } }
          );
          await sendMessage(chatId, "Mahsulot narxi yangilandi ✅");
          userStateById.delete(chatId);
          await homeMenu(chatId);
        } else {
          await sendMessage(
            chatId,
            "Iltimos, to'g'ri narx kiriting (masalan: 10,000 som)"
          );
        }
        res.sendStatus(200);
        return;
      }

      if (state.expected === "delivery_radius") {
        if (text === "Hamma joyga") {
          try {
            await models.User.update(
              { deliveryRadius: null },
              { where: { chatId } }
            );
          } catch (e) {
            console.error(
              "Sequelize update (deliveryRadius unlimited) failed:",
              e.message || e
            );
          }
          await homeMenu(chatId);
          userStateById.delete(chatId);
          res.sendStatus(200);
          return;
        } else if (text === "Boshqa") {
          userStateById.set(chatId, { expected: "delivery_radius_custom" });
          await sendMessage(
            chatId,
            "Necha km yetkazib bera olasiz? (Raqam kiriting, masalan: 10)",
            {
              reply_markup: { remove_keyboard: true },
            }
          );
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
              console.error(
                "Sequelize update (deliveryRadius) failed:",
                e.message || e
              );
            }
            await homeMenu(chatId);
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
            console.error(
              "Sequelize update (deliveryRadius custom) failed:",
              e.message || e
            );
          }
          await homeMenu(chatId);
          userStateById.delete(chatId);
          res.sendStatus(200);
          return;
        } else {
          await sendMessage(
            chatId,
            "Iltimos, to'g'ri raqam kiriting (masalan: 10)"
          );
          res.sendStatus(200);
          return;
        }
      }

      if (text === "Maxsulot qo'shish ➕") {
        userStateById.set(chatId, { expected: "product_size" });
        await askProduct(chatId);
        res.sendStatus(200);
        return;
      }
      if (text === "Maxsulotlarimni korish👁️") {
        await showProducts(chatId, 1);
        res.sendStatus(200);
        return;
      }

      if (state.expected === "product_size") {
        if (/^boshqa$/i.test(text)) {
          userStateById.set(chatId, { expected: "product_size_custom" });
          await sendMessage(chatId, "Necha litr? (masalan: 7)", {
            reply_markup: { remove_keyboard: true },
          });
          res.sendStatus(200);
          return;
        }
        const m = text.match(/^(\d+)\s*l/i);
        if (m) {
          const size = parseInt(m[1], 10);
          const st = userStateById.get(chatId) || {};
          st.productSize = size;
          st.expected = "product_price";
          userStateById.set(chatId, st);
          await sendMessage(chatId, `Maxsulot qoshildi ${st.productSize} litr`);
          await askPrice(chatId);
          res.sendStatus(200);
          return;
        }
        if (/^\d+$/.test(text)) {
          const size = parseInt(text, 10);
          if (size > 0) {
            const st = userStateById.get(chatId) || {};
            st.productSize = size;
            st.expected = "product_price";
            userStateById.set(chatId, st);
            await sendMessage(
              chatId,
              `Maxsulot qoshildi ${st.productSize} litr`
            );
            await askPrice(chatId);
            res.sendStatus(200);
            return;
          }
        }
      }

      if (state.expected === "product_size_custom") {
        const size = parseInt(text.replace(/[^\d]/g, ""), 10);
        if (!isNaN(size) && size > 0) {
          const st = userStateById.get(chatId) || {};
          st.productSize = size;
          st.expected = "product_price";
          userStateById.set(chatId, st);
          await sendMessage(chatId, `Maxsulot qoshildi ${st.productSize} litr`);
          await askPrice(chatId);
          res.sendStatus(200);
          return;
        } else {
          await sendMessage(
            chatId,
            "Iltimos to'g'ri son kiriting (masalan: 7)"
          );
          res.sendStatus(200);
          return;
        }
      }

      if (state.expected === "product_price") {
        if (text === "O'zim narx belgilayman") {
          const st = userStateById.get(chatId) || {};
          st.expected = "product_price_custom";
          userStateById.set(chatId, st);
          await sendMessage(
            chatId,
            "Boshqa narx kiritmoqchimisiz? unda yozing misol: 10,000 som",
            { reply_markup: { remove_keyboard: true } }
          );
          res.sendStatus(200);
          return;
        }
        const price = parseInt(text.replace(/[^\d]/g, ""), 10);
        if (!isNaN(price) && price > 0) {
          if (price > 17000) {
            await sendMessage(
              chatId,
              "qayta narx kiriting maksimal narx miqdori 17,000 som"
            );
            res.sendStatus(200);
            return;
          }
          const st = userStateById.get(chatId) || {};
          st.productPrice = price;
          st.expected = "product_confirm";
          userStateById.set(chatId, st);
          await sendMessage(
            chatId,
            `Maxsulot ma'lumotlari:\nHajmi: ${st.productSize} litr\n1 litr uchun narx: ${st.productPrice} som\n\nTasdiqlaysizmi?`,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: "Ha ✅", callback_data: "prod_confirm_yes" },
                    { text: "Yo'q ❌", callback_data: "prod_confirm_no" },
                  ],
                ],
              },
            }
          );
          res.sendStatus(200);
          return;
        } else {
          await sendMessage(
            chatId,
            "Iltimos, to'g'ri narx tanlang yoki kiriting."
          );
          res.sendStatus(200);
          return;
        }
      }

      if (state.expected === "product_price_custom") {
        const m = text.match(/^\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\s*som)?\s*$/i);
        if (m) {
          const normalized = m[1].replace(/,/g, "");
          const price = parseInt(normalized, 10);
          if (!isNaN(price) && price > 0) {
            if (price > 17000) {
              await sendMessage(
                chatId,
                "qayta narx kiriting maksimal narx miqdori 17,000 som"
              );
              res.sendStatus(200);
              return;
            }
            const st = userStateById.get(chatId) || {};
            st.productPrice = price;
            st.expected = "product_confirm";
            userStateById.set(chatId, st);
            await sendMessage(
              chatId,
              `Maxsulot ma'lumotlari:\nHajmi: ${st.productSize} litr\n1 litr uchun narx: ${st.productPrice} som\n\nTasdiqlaysizmi?`,
              {
                reply_markup: {
                  inline_keyboard: [
                    [
                      { text: "Ha ✅", callback_data: "prod_confirm_yes" },
                      { text: "Yo'q ❌", callback_data: "prod_confirm_no" },
                    ],
                  ],
                },
              }
            );
            res.sendStatus(200);
            return;
          }
        }
        await sendMessage(
          chatId,
          "xato yozdingiz bunday bolishi kerak misol: 10,000 som"
        );
        res.sendStatus(200);
        return;
      }

      if (text === "/start" || text.startsWith("/start")) {
        const from = message.from || {};
        const telegramId = from.id;
        const fullName = [from.first_name, from.last_name]
          .filter(Boolean)
          .join(" ")
          .trim();
        const username = from.username || null;

        try {
          const existingUser = await models.User.findOne({
            where: { telegramId },
          });

          if (existingUser) {
            await sendMessage(
              chatId,
              `Hisobga kirildi✅:\n\n` +
                `🆔ID: ${existingUser.telegramId}\n` +
                `📞Telefon raqamingiz: ${existingUser.phone || "—"}\n` +
                `👤Ismingiz: ${existingUser.fullName || "—"}`,
              {
                reply_markup: {
                  keyboard: [
                    [{ text: "Maxsulot qo'shish ➕" }],
                    [{ text: "Maxsulotlarimni korish👁️" }],
                  ],
                  resize_keyboard: true,
                },
              }
            );
            res.sendStatus(200);
            return;
          }

          const newUser = await models.User.create({
            telegramId,
            chatId,
            fullName,
            username,
          });

          userStateById.set(chatId, { expected: "phone" });
          await sendMessage(
            chatId,
            `Oq Chelack Business ga hush kelibsiz! Ro'yhatdan o'tamiz.\n\nSizning Telegram ID raqamingiz: ${telegramId}`
          );
          await askPhone(chatId);
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
};
