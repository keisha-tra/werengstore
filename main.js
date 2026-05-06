// main.js - Mova Digital System (Enhanced Admin Reply)

require("./setting");
const { Telegraf, Markup } = require("telegraf");
const fs = require("fs");
const chalk = require("chalk");
const moment = require("moment-timezone");
const axios = require("axios");
const crypto = require("crypto");
const hashC = (str) =>
  crypto.createHash("md5").update(str).digest("hex").substring(0, 16);
const findC = (h, list) => list.find((x) => hashC(x) === h);
const sanitizeMD = (str) => String(str).replace(/[_*[\]`]/g, "");
const sanitizeHTML = (str) =>
  String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
const QRCode = require("qrcode");
const figlet = require("figlet");
const AdmZip = require("adm-zip");
const path = require("path");

class Mutex {
  constructor() {
    this._locking = Promise.resolve();
  }
  lock() {
    let unlockNext;
    let willLock = new Promise((resolve) => (unlockNext = resolve));
    let willUnlock = this._locking.then(() => unlockNext);
    this._locking = this._locking.then(() => willLock);
    return willUnlock;
  }
}
const dbMutex = new Mutex();

/**
 * SISTEM LOGGING TERMINAL
 */
const log = {
  info: (m) =>
    console.log(chalk.blue(`[INFO] [${moment().format("HH:mm:ss")}] ${m}`)),
  success: (m) =>
    console.log(chalk.green(`[SUCCESS] [${moment().format("HH:mm:ss")}] ${m}`)),
  error: (m, e) => {
    console.log(chalk.red(`[ERROR] [${moment().format("HH:mm:ss")}] ${m}`));
    if (e && e.response && e.response.data)
      console.log(
        chalk.red(`➤ Response API: ${JSON.stringify(e.response.data)}`),
      );
    else if (e && e.response && e.response.description)
      console.log(chalk.red(`➤ API Detail: ${e.response.description}`));
    else if (e) console.log(chalk.red(`➤ Detail: ${e.message || e}`));
  },
};

// === DATABASE CONFIG ===
const db_path = {
  user: "./database/user.json",
  trx: "./database/transactions.json",
  store: "./database/store.json",
  promo: "./database/promo.json",
  flashsale: "./database/flashsale.json",
  settings: "./database/settings.json",
};

const readDB = (p) => {
  if (!fs.existsSync("./database")) fs.mkdirSync("./database");
  if (!fs.existsSync(p)) {
    let init;
    if (p.includes("store")) init = { categories: [], products: [] };
    else if (p.includes("settings"))
      init = { success_sticker: "", cancel_sticker: "" };
    else init = [];
    fs.writeFileSync(p, JSON.stringify(init));
  }
  try {
    return JSON.parse(fs.readFileSync(p));
  } catch (e) {
    if (p.includes("store")) return { categories: [], products: [] };
    if (p.includes("settings"))
      return { success_sticker: "", cancel_sticker: "", ratings: [] };
    return [];
  }
};
const writeDB = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2));

// === CONFIG SYNC ===
moment.tz.setDefault("Asia/Jakarta").locale("id");
const tanggal = () => moment.tz("Asia/Jakarta").format("DD MMMM YYYY");

const PAKASIR_KEY = global.PAKASIR_API_KEY;
const PAKASIR_SLUG = global.PAKASIR_PROJECT_SLUG;
const OWNER_ID = String(global.OWNER_ID);
const THUMBNAIL = global.thumbnail || "./options/image/thumbnail.jpg";

const bot = new Telegraf(global.BOT_TOKEN);
const userState = new Map();
const activeChats = new Map();

/**
 * FUNGSI KIRIM STIKER SUKSES
 */
async function sendSuccessSticker(userId) {
  const settings = readDB(db_path.settings);
  if (settings.success_sticker) {
    try {
      await bot.telegram.sendSticker(userId, settings.success_sticker);
    } catch (e) {
      log.error("Gagal mengirim stiker sukses", e);
    }
  }
}

/**
 * FUNGSI KIRIM STIKER BATAL
 */
async function sendCancelSticker(userId) {
  const settings = readDB(db_path.settings);
  if (settings.cancel_sticker) {
    try {
      await bot.telegram.sendSticker(userId, settings.cancel_sticker);
    } catch (e) {
      log.error("Gagal mengirim stiker batal", e);
    }
  }
}

/**
 * PAKASIR API CORE
 */
async function checkStatusPakasir(orderId, amount) {
  try {
    const url = `https://app.pakasir.com/api/transactiondetail?project=${PAKASIR_SLUG}&amount=${amount}&order_id=${orderId}&api_key=${PAKASIR_KEY}`;
    const res = await axios.get(url, { timeout: 10000 });

    if (res.data && res.data.transaction) {
      const status = res.data.transaction.status.toLowerCase();
      if (status === "completed" || status === "paid" || status === "sukses") {
        return "PAID";
      }
    }
    return "UNPAID";
  } catch (e) {
    return "ERROR";
  }
}

/**
 * FUNGSI PROSES PEMBAYARAN / PENGIRIMAN (VERSI FIXED)
 */
async function processDelivery(tx, users, store) {
  let handled = false;
  try {
    if (tx.type === "topup") {
      const uIdx = users.findIndex((u) => String(u.id) === String(tx.userId));
      if (uIdx !== -1) {
        users[uIdx].balance += parseInt(tx.amount);
        tx.status = "success";
        tx.completed_at = moment().format();
        await bot.telegram.sendMessage(
          tx.userId,
          `✅ *TOPUP BERHASIL*\n━━━━━━━━━━━━━━━━━━\n💰 Saldo: *+Rp ${tx.amount.toLocaleString()}*\n💳 Total Saldo Sekarang: *Rp ${users[uIdx].balance.toLocaleString()}*\n\nTerima kasih telah melakukan pengisian saldo.`,
          { parse_mode: "Markdown" },
        );

        await sendSuccessSticker(tx.userId);

        // --- KIRIM PESAN SUKSES KE CHANNEL (TOPUP) ---
        try {
          if (global.CHANNEL) {
            let chUsername = global.CHANNEL.includes("t.me/")
              ? "@" + global.CHANNEL.split("t.me/")[1].split("/")[0]
              : global.CHANNEL;

            if (chUsername) {
              const b_user = users[uIdx];
              const b_name = b_user ? b_user.name : "User";
              const safeNameStr = sanitizeMD(b_name);
              const invId = tx.orderId
                ? tx.orderId
                : `TOP${moment().format("YYYYMMDDHHmmss")}`;

              const chMsg = `✅ *Notifikasi Topup Berhasil* ✅\n\nPembeli: *${safeNameStr}*\nID Pesanan: \`${invId}\`\nMetode Bayar: _QRIS_\nTotal Topup: *Rp${tx.amount.toLocaleString("id-ID")}*\n\n_Terima kasih telah mempercayakan transaksi Anda kepada kami!_ 🚀\n\n#TopupBerhasil #BuktiPembayaran #AutoBot`;
              await bot.telegram.sendMessage(chUsername, chMsg, {
                parse_mode: "Markdown",
              });
            }
          }
        } catch (errChannel) {
          log.error("Gagal kirim notif topup ke channel", errChannel);
        }

        handled = true;
      }
    } else if (tx.type === "direct") {
      const pIdx = store.products.findIndex((p) => p.id === tx.productId);
      if (pIdx !== -1) {
        const product = store.products[pIdx];
        if (product.stocks.length >= tx.qty) {
          const items = product.stocks.splice(0, tx.qty);
          tx.status = "success";
          tx.completed_at = moment().format();

          const detail = items
            .map((it, i) => {
              if (it.isLink || !it.pw) {
                return `Data ${i + 1}:\n🔗 ${it.email}`;
              } else {
                let str = `Akun ${i + 1}:\nEmail: ${it.email}\nPW: ${it.pw}`;
                if (it.pin) str += `\nPIN: ${it.pin}`;
                if (it.a2f) str += `\nA2F: ${it.a2f}`;
                if (it.profile) str += `\nProfile: ${it.profile}`;
                return str;
              }
            })
            .join("\n\n");

          // --- LOGIKA PESAN SUKSES DINAMIS & RATING ---
          let extraText = product.success_msg
            ? `\n\n ${product.success_msg}`
            : "";

          const msg1_summary = `✅ *PEMBAYARAN BERHASIL*
━━━━━━━━━━━━━━━━━━
🛍️ *Produk:* ${tx.productName}
📦 *Jumlah:* ${tx.qty}x
💰 *Total:* Rp ${tx.amount.toLocaleString()}
━━━━━━━━━━━━━━━━━━
📝 _Pesanan Anda sedang diproses oleh sistem._`;

          const msg2_data = `🔑 *DATA PESANAN ANDA:*
\`\`\`
${detail}
\`\`\`${extraText}`;

          const msg3_rating = `🌟 *RATING & TESTIMONI*
Bagaimana pengalaman Anda membeli produk ini? Berikan penilaian Anda:`;

          const kbRating = Markup.inlineKeyboard([
            [
              Markup.button.callback("⭐", "rate_1"),
              Markup.button.callback("⭐⭐", "rate_2"),
              Markup.button.callback("⭐⭐⭐", "rate_3"),
            ],
            [
              Markup.button.callback("⭐⭐⭐⭐", "rate_4"),
              Markup.button.callback("⭐⭐⭐⭐⭐", "rate_5"),
            ],
          ]);

          // KIRIM PESAN 1: Summary
          await bot.telegram.sendMessage(tx.userId, msg1_summary, {
            parse_mode: "Markdown",
          });

          // KIRIM PESAN 2: Data + Tutorial (Custom Video jika ada)
          if (product.mediaId) {
            try {
              // Coba kirim sebagai video, jika gagal coba photo/dokumen
              await bot.telegram.sendVideo(tx.userId, product.mediaId, {
                caption: msg2_data,
                parse_mode: "Markdown",
              });
            } catch (e) {
              try {
                await bot.telegram.sendPhoto(tx.userId, product.mediaId, {
                  caption: msg2_data,
                  parse_mode: "Markdown",
                });
              } catch (err) {
                await bot.telegram.sendMessage(tx.userId, msg2_data, {
                  parse_mode: "Markdown",
                });
              }
            }
          } else {
            await bot.telegram.sendMessage(tx.userId, msg2_data, {
              parse_mode: "Markdown",
            });
          }

          // KIRIM PESAN 3: Rating
          await bot.telegram.sendMessage(tx.userId, msg3_rating, {
            parse_mode: "Markdown",
            ...kbRating,
          });

          // --- KIRIM PESAN SUKSES KE CHANNEL ---
          try {
            if (global.CHANNEL) {
              let chUsername = global.CHANNEL.includes("t.me/")
                ? "@" + global.CHANNEL.split("t.me/")[1].split("/")[0]
                : global.CHANNEL;

              if (chUsername) {
                const b_user = users.find(
                  (u) => String(u.id) === String(tx.userId),
                );
                const b_name = b_user ? b_user.name : "User";
                const invId = tx.orderId
                  ? tx.orderId
                  : `INV${moment().format("YYYYMMDDHHmmss")}`;

                const safeNameStr = sanitizeMD(b_name);
                const isSaldo = invId.startsWith("BAL");
                const paymentMethod = isSaldo ? "SALDO" : "QRIS";
                const chMsg = `✅ *Notifikasi Pesanan Berhasil* ✅

Pembeli: *${safeNameStr}*
ID Pesanan: \`${invId}\`
Detail Produk: ${tx.productName}
Metode Beli: _${paymentMethod}_
Total Harga: *Rp${tx.amount.toLocaleString("id-ID")}*

_Terima kasih telah mempercayakan transaksi Anda kepada kami!_ 🚀

#TransaksiBerhasil #BuktiPembayaran #AutoBot`;

                await bot.telegram.sendMessage(chUsername, chMsg, {
                  parse_mode: "Markdown",
                });
              }
            }
          } catch (errChannel) {
            log.error("Gagal kirim notif ke channel", errChannel);
          }

          handled = true;
        } else {
          await bot.telegram.sendMessage(
            tx.userId,
            `⚠️ *PEMBAYARAN SUKSES* tapi stok *${tx.productName}* baru saja habis. Mohon hubungi Admin untuk klaim manual.`,
          );
          tx.status = "error_stok";
          handled = true;
        }
      }
    }
  } catch (e) {
    console.log("Delivery Error", e);
  }
  return handled;
}

/**
 * LOGIKA PENGAJUAN TOPUP
 */
async function createTopupRequest(ctx, amount) {
  if (isNaN(amount) || amount < 1000) {
    return ctx.reply("❌ Minimal topup adalah Rp 1.000");
  }

  const orderId = `TOP${Date.now()}`;
  const waitMsg = await ctx.reply("⌛ Menyiapkan QRIS Pakasir...");

  try {
    const payload = {
      project: PAKASIR_SLUG,
      order_id: orderId,
      amount,
      api_key: PAKASIR_KEY,
    };
    const res = await axios.post(
      "https://app.pakasir.com/api/transactioncreate/qris",
      payload,
      { headers: { "Content-Type": "application/json" }, timeout: 10000 },
    );

    if (res.data && res.data.payment) {
      const qr = await QRCode.toBuffer(res.data.payment.payment_number);
      let txs = readDB(db_path.trx);
      txs.push({
        orderId,
        userId: ctx.from.id,
        amount,
        status: "pending",
        type: "topup",
        date: moment().format(),
      });
      writeDB(db_path.trx, txs);

      try {
        await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id);
      } catch (e) { }

      await ctx.replyWithPhoto(
        { source: qr },
        {
          caption: `💳 *PEMBAYARAN TOPUP*\n━━━━━━━━━━━━━━━━━━\nID: \`${orderId}\`\nTotal: *Rp ${res.data.payment.total_payment.toLocaleString()}*\n\n_Sistem akan mengecek otomatis, atau klik tombol di bawah untuk cek manual._`,
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback(
                "✅ Cek Status Manual",
                `check_trx_${orderId}`,
              ),
            ],
            [
              Markup.button.callback(
                "❌ Batal Pembayaran",
                `cancel_trx_${orderId}`,
              ),
            ],
          ]),
        },
      );
    } else {
      throw new Error("Invalid response from Pakasir");
    }
  } catch (e) {
    log.error("API Topup Error", e);
    ctx.reply("❌ Gagal membuat QRIS. Pastikan API Key Pakasir benar.");
  }
}

function revertKuota(tx) {
  if (tx.fsApplied) {
    let fsList = readDB(db_path.flashsale) || [];
    const fsIdx = fsList.findIndex((x) => x.productId === tx.productId);
    if (fsIdx !== -1) {
      fsList[fsIdx].usedCount -= tx.qty || 1;
      if (fsList[fsIdx].usedCount < 0) fsList[fsIdx].usedCount = 0;
      writeDB(db_path.flashsale, fsList);
    }
  }
  if (tx.voucherApplied) {
    let promos = readDB(db_path.promo);
    const vIdx = promos.findIndex((p) => p.code === tx.voucherApplied);
    if (vIdx !== -1 && promos[vIdx].usedBy) {
      const uIdx = promos[vIdx].usedBy.indexOf(tx.userId);
      if (uIdx !== -1) {
        promos[vIdx].usedBy.splice(uIdx, 1);
        writeDB(db_path.promo, promos);
      }
    }
  }
}

/**
 * LOOP PENGECEKAN TRANSAKSI
 */
async function paymentLoop() {
  const unlock = await dbMutex.lock();
  try {
    let trxs = readDB(db_path.trx);
    let users = readDB(db_path.user);
    let store = readDB(db_path.store);
    let changed = false;

    for (let tx of trxs) {
      if (tx.status === "pending") {
        const txTime = moment(tx.date);
        if (moment().diff(txTime, "minutes") > 6) {
          tx.status = "expired";
          revertKuota(tx);
          changed = true;
          continue;
        }

        const status = await checkStatusPakasir(tx.orderId, tx.amount);
        if (status === "PAID") {
          if (await processDelivery(tx, users, store)) changed = true;
        }
      }
    }

    if (changed) {
      writeDB(db_path.trx, trxs);
      writeDB(db_path.user, users);
      writeDB(db_path.store, store);
    }
  } finally {
    unlock();
  }
}

// === KEYBOARDS ===
const kbMain = (id) => Markup.removeKeyboard();

const kbAdmin = {
  reply_markup: {
    keyboard: [
      [{ text: "➕ Tambah Data" }, { text: "✏️ Edit Data" }],
      [{ text: "📦 Kelola Stok" }, { text: "🗑️ Hapus Data" }],
      [{ text: "🎟️ Promo & Diskon" }, { text: "💰 Kelola Saldo" }],
      [{ text: "📂 Backup Data" }, { text: "📢 Broadcast" }],
      [{ text: "⚙️ Set Sticker" }, { text: "🔙 Menu Utama" }],
    ],
    resize_keyboard: true,
  },
};

const kbUser = {
  reply_markup: {
    keyboard: [
      [{ text: "🏠 Laman Utama" }, { text: "🛒 Katalog Produk" }],
    ],
    resize_keyboard: true,
  },
};

const kbAddMenu = {
  reply_markup: {
    keyboard: [
      [{ text: "➕ Kategori" }, { text: "➕ Produk" }],
      [{ text: "🔙 Menu Admin" }],
    ],
    resize_keyboard: true,
  },
};

const kbEditMenu = {
  reply_markup: {
    keyboard: [
      [{ text: "✏️ Edit Kategori" }, { text: "✏️ Edit Produk" }],
      [{ text: "🔙 Menu Admin" }],
    ],
    resize_keyboard: true,
  },
};

const kbStockMenu = {
  reply_markup: {
    keyboard: [
      [{ text: "➕ Isi Stok" }, { text: "🔑 Ambil Stok" }],
      [{ text: "🔙 Menu Admin" }],
    ],
    resize_keyboard: true,
  },
};

const kbPromoMenu = {
  reply_markup: {
    keyboard: [
      [{ text: "🎟️ Voucher & Promo" }, { text: "⚡ Set Flash Sale" }],
      [{ text: "🔙 Menu Admin" }],
    ],
    resize_keyboard: true,
  },
};

const kbDeleteMenu = {
  reply_markup: {
    keyboard: [
      [{ text: "➖ Hapus Kategori" }, { text: "➖ Hapus Produk" }],
      [{ text: "➖ Kosongkan Stok" }],
      [{ text: "🔙 Menu Admin" }],
    ],
    resize_keyboard: true,
  },
};

const kbChat = {
  reply_markup: {
    keyboard: [[{ text: "🛑 AKHIRI CHAT" }]],
    resize_keyboard: true,
  },
};

// === MIDDLEWARE FORCE SUBSCRIBE ===
bot.use(async (ctx, next) => {
  // TAMBAHKAN BARIS INI: Abaikan jika tidak ada konteks user (misal: sistem update/bot diblokir)
  if (!ctx.from || !ctx.from.id) return next();

  if (String(ctx.from.id) === OWNER_ID) return next();
  if (ctx.callbackQuery && ctx.callbackQuery.data === "cek_join") return next();

  if (global.CHANNEL && global.CHANNEL.trim() !== "") {
    try {
      let targetChat = global.CHANNEL;
      if (targetChat.includes("t.me/") && !targetChat.includes("t.me/+")) {
        targetChat = "@" + targetChat.split("t.me/")[1].split("/")[0];
      } else if (targetChat.includes("t.me/+")) {
        targetChat = null;
      }
      if (targetChat && !isNaN(Number(targetChat)))
        targetChat = Number(targetChat);

      if (targetChat) {
        const member = await bot.telegram.getChatMember(
          targetChat,
          ctx.from.id,
        );
        if (member.status === "left" || member.status === "kicked") {
          const safeNameHtml = sanitizeHTML(ctx.from.first_name || "Kak");
          const textLock = `🔒 <b>AKSES DITUTUP SEMENTARA</b>\n\nHai <b>${safeNameHtml}</b>! Untuk menikmati layanan dan transaksi di bot ini, kamu diwajibkan untuk bergabung ke grup/channel resmi kami. \n\nSilakan bergabung melalui tombol di bawah ini:`;
          const btnLink = global.CHANNEL.includes("t.me")
            ? global.CHANNEL
            : `https://t.me/c/${global.CHANNEL.replace("-100", "")}/1`;

          const kbLock = Markup.inlineKeyboard([
            [Markup.button.url("📢 Gabung Channel/Grup", btnLink)],
            [Markup.button.callback("✅ Saya Sudah Gabung", "cek_join")],
          ]);

          if (ctx.callbackQuery) {
            return ctx
              .answerCbQuery(
                "Akses terkunci! Silakan cek pesan terbaru dari bot.",
                { show_alert: true },
              )
              .catch(() => { });
          } else {
            return ctx.reply(textLock, {
              parse_mode: "HTML",
              ...kbLock,
              disable_web_page_preview: true,
            });
          }
        }
      }
    } catch (e) {
      console.log("Error Force Join:", e.message);
    }
  }

  return next();
});

bot.action("cek_join", async (ctx) => {
  try {
    let targetChat = global.CHANNEL;
    if (targetChat.includes("t.me/") && !targetChat.includes("t.me/+")) {
      targetChat = "@" + targetChat.split("t.me/")[1].split("/")[0];
    } else if (targetChat.includes("t.me/+")) {
      targetChat = null;
    }
    if (targetChat && !isNaN(Number(targetChat)))
      targetChat = Number(targetChat);

    if (targetChat) {
      const member = await bot.telegram.getChatMember(targetChat, ctx.from.id);

      if (member.status !== "left" && member.status !== "kicked") {
        await ctx.deleteMessage().catch(() => { });
        return ctx.reply(
          "🎉 <b>Selamat Datang Akses Terbuka!</b>\n\nTerima kasih telah bergabung. Silakan ketik /start untuk mulai berbelanja.",
          { parse_mode: "HTML" },
        );
      } else {
        return ctx.answerCbQuery(
          "⚠️ Kamu terdeteksi belum bergabung! Coba gabung lalu klik lagi.",
          { show_alert: true },
        );
      }
    }
  } catch (e) {
    ctx
      .answerCbQuery(
        "Gagal memverifikasi. Pastikan bot adalah admin di channel/grup.",
      )
      .catch(() => { });
  }
});

// === COMMANDS ===
const getStartMessage = (ctx, user, uLen, trxs) => {
  const hour = moment.tz("Asia/Jakarta").hour();
  let greeting = "Selamat Malam";
  if (hour >= 4 && hour < 10) greeting = "Selamat Pagi";
  else if (hour >= 10 && hour < 15) greeting = "Selamat Siang";
  else if (hour >= 15 && hour < 18) greeting = "Selamat Sore";

  const timeStr = moment
    .tz("Asia/Jakarta")
    .format("dddd, D MMMM YYYY [pukul] HH.mm.ss [WIB]");
  const successTrxs = trxs.filter((x) => x.status === "success");
  const userTrxCount = trxs.filter(
    (x) => String(x.userId) === String(ctx.from?.id) && x.status === "success",
  ).length;
  const botName = (global.BOT_NAME || "STORE").toUpperCase();

  const settings = readDB(db_path.settings);
  const ratings = settings.ratings || [];
  let avgRating = 5.0;
  if (ratings.length > 0) {
    const sum = ratings.reduce((a, b) => a + b.score, 0);
    avgRating = (sum / ratings.length).toFixed(1);
  }
  const reviewCount = ratings.length > 0 ? ratings.length : 0;

  const safeNameHTML = sanitizeHTML(ctx.from?.first_name || "User");
  let text = `${greeting}, <b>${safeNameHTML}</b>! ✨\n📆 <i>${timeStr}</i>\n\nSelamat Datang di <b>${botName}</b>.\n━━━━━━━━━━━━━━━━━━\n👤 <b>STATISTIK AKUN</b>\n┣ 💰 Saldo Aktif : <b>Rp ${user.balance.toLocaleString("id-ID")}</b>\n┗ 🛍️ Total Order : <b>${userTrxCount} Transaksi</b>\n\n📊 <b>STATISTIK BOT</b>\n┣ ⭐ Rating : <b>${avgRating} / 5.0</b> (${reviewCount} ulasan)\n┣ 👥 Total Pengguna : <b>${uLen.toLocaleString("id-ID")}</b>\n┗ 🧾 Total Penjualan : <b>${successTrxs.length.toLocaleString("id-ID")}</b>x\n━━━━━━━━━━━━━━━━━━\nSilakan gunakan menu di bawah untuk mulai bertransaksi atau ketik /produk.`;

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("⚡ FLASH SALE", "menu_flash_sale")],
    [
      Markup.button.callback("🛒 DAFTAR PRODUK", "menu_belanja"),
      Markup.button.callback("💎 TOPUP SALDO", "menu_topup"),
    ],
    [
      Markup.button.callback("🔥 PRODUK POPULER", "menu_populer"),
      Markup.button.callback("👤 PROFIL SAYA", "menu_profil"),
    ],
  ]);
  if (String(ctx.from?.id) === OWNER_ID)
    kb.reply_markup.inline_keyboard.push([
      Markup.button.callback("🛠 MENU ADMIN", "menu_admin"),
    ]);

  return { text, kb };
};

bot.command("start", async (ctx) => {
  let u = readDB(db_path.user);
  let user = u.find((x) => String(x.id) === String(ctx.from.id));
  if (!user) {
    user = {
      id: ctx.from.id,
      name: ctx.from.first_name,
      balance: 0,
      joined: tanggal(),
    };
    u.push(user);
    writeDB(db_path.user, u);
  }
  userState.delete(ctx.from.id);
  activeChats.delete(ctx.from.id);

  // --- TAMBAHAN: Set Keyboard Bawah Sesuai Role ---
  const userKb = String(ctx.from.id) === OWNER_ID ? kbAdmin : kbUser;
  // Menampilkan keyboard secara permanen (menghapus pesan akan menghilangkan keyboard di Telegram versi terbaru)
  await ctx.reply("🔄 Memuat sistem bot...", userKb);
  // ------------------------------------------------

  const { text, kb } = getStartMessage(
    ctx,
    user,
    u.length,
    readDB(db_path.trx),
  );
  try {
    await ctx.replyWithPhoto(
      { source: THUMBNAIL },
      { caption: text, parse_mode: "HTML", ...kb },
    );
  } catch (e) {
    try {
      await ctx.reply(text, { parse_mode: "HTML", ...kb });
    } catch (err) {
      console.error("Error start msg:", err);
      await ctx.reply("Sistem Bot Siap Digunakan. Ketik /produk", kb);
    }
  }
});

bot.command("backupdb", async (ctx) => {
  if (String(ctx.from.id) !== OWNER_ID) return;
  const waitMsg = await ctx.reply("⏳ Menyiapkan backup sistem via ZIP...");
  try {
    const zip = new AdmZip();

    // Add explicit files requested by the user
    const targetFiles = [
      "balz.js",
      "index.js",
      "main.js",
      "package.json",
      "setting.js",
    ];
    targetFiles.forEach((file) => {
      const p = path.join(__dirname, file);
      if (fs.existsSync(p)) zip.addLocalFile(p);
    });

    // Add directories requested by the user
    const targetDirs = ["database", "function", "options"];
    targetDirs.forEach((dir) => {
      const p = path.join(__dirname, dir);
      if (fs.existsSync(p)) zip.addLocalFolder(p, dir);
    });

    const buffer = zip.toBuffer();
    const timestamp = moment().format("YYYYMMDD_HHmmss");

    await ctx.replyWithDocument(
      {
        source: buffer,
        filename: `Backup_Bot_${timestamp}.zip`,
      },
      {
        caption:
          "✅ *BACKUP SUKSES*\n\nBerikut adalah cadangan file dan database bot Anda.",
        parse_mode: "Markdown",
      },
    );

    await ctx.deleteMessage(waitMsg.message_id).catch(() => { });
  } catch (e) {
    log.error("Gagal backup", e);
    ctx.reply("❌ Terjadi kesalahan saat membuat file zip backup.");
    await ctx.deleteMessage(waitMsg.message_id).catch(() => { });
  }
});

bot.command("topup", async (ctx) => {
  const amountStr = ctx.message.text.split(" ")[1];
  if (!amountStr)
    return ctx.reply("❌ Format salah. Contoh: `/topup 10000`", {
      parse_mode: "Markdown",
    });
  const amount = parseInt(amountStr);
  await createTopupRequest(ctx, amount);
});

/**
 * COMMAND BALAS UNTUK ADMIN
 * Format: /balas [ID_USER] [PESAN]
 */
bot.command("balas", async (ctx) => {
  if (String(ctx.from.id) !== OWNER_ID) return;
  const args = ctx.message.text.split(" ");
  if (args.length < 3)
    return ctx.reply(
      "❌ Format salah!\nContoh: `/balas 1234567 Halo ada yang bisa dibantu?`",
      { parse_mode: "Markdown" },
    );

  const targetId = args[1];
  const message = args.slice(2).join(" ");

  try {
    await bot.telegram.sendMessage(
      targetId,
      `💬 *PESAN DARI ADMIN:*\n\n${message}`,
      { parse_mode: "Markdown" },
    );
    ctx.reply(`✅ Pesan berhasil terkirim ke user \`${targetId}\`.`, {
      parse_mode: "Markdown",
    });
  } catch (e) {
    ctx.reply(
      `❌ Gagal mengirim pesan ke \`${targetId}\`. User mungkin memblokir bot.`,
    );
  }
});

// === MENU HEARS ===

bot.command(["produk", "daftarproduk", "katalog"], async (ctx) => {
  userState.delete(ctx.from.id);
  const s = readDB(db_path.store);
  const cats = [...new Set(s.categories)].sort();
  const { text, kb } = getCatalogPage(1, cats, s.products);
  try {
    await ctx.replyWithPhoto(
      { source: THUMBNAIL },
      { caption: text, parse_mode: "Markdown", ...kb },
    );
  } catch (e) {
    await ctx.reply(text, { parse_mode: "Markdown", ...kb });
  }
});

bot.hears(/🛒 Belanja/i, async (ctx) => {
  userState.delete(ctx.from.id);
  const s = readDB(db_path.store);
  const cats = [...new Set(s.categories)].sort();
  const { text, kb } = getCatalogPage(1, cats, s.products);
  try {
    await ctx.replyWithPhoto(
      { source: THUMBNAIL },
      { caption: text, parse_mode: "Markdown", ...kb },
    );
  } catch (e) {
    await ctx.reply(text, { parse_mode: "Markdown", ...kb });
  }
});

bot.hears(/🏠 Laman Utama/i, async (ctx) => {
  userState.delete(ctx.from.id);
  const u = readDB(db_path.user);
  const user = u.find((x) => String(x.id) === String(ctx.from.id));
  if (user) {
    const { text, kb } = getStartMessage(
      ctx,
      user,
      u.length,
      readDB(db_path.trx),
    );
    try {
      await ctx.replyWithPhoto(
        { source: THUMBNAIL },
        { caption: text, parse_mode: "HTML", ...kb },
      );
    } catch (e) {
      await ctx.reply(text, { parse_mode: "HTML", ...kb });
    }
  } else {
    ctx.reply("⚠️ Sesi tidak ditemukan, silakan ketik /start terlebih dahulu.");
  }
});

bot.hears(/🛒 Katalog Produk/i, async (ctx) => {
  userState.delete(ctx.from.id);
  const s = readDB(db_path.store);
  const cats = [...new Set(s.categories)].sort();
  const { text, kb } = getCatalogPage(1, cats, s.products);
  try {
    await ctx.replyWithPhoto(
      { source: THUMBNAIL },
      { caption: text, parse_mode: "Markdown", ...kb },
    );
  } catch (e) {
    await ctx.reply(text, { parse_mode: "Markdown", ...kb });
  }
});


bot.action("menu_flash_sale", async (ctx) => {
  userState.delete(ctx.from.id);
  const fsList = readDB(db_path.flashsale);
  const backBtn = [
    Markup.button.callback("🏠 Kembali ke Home", "back_to_home"),
  ];
  const refreshBtn = Markup.button.callback(
    "🔄 Refresh Waktu",
    "menu_flash_sale",
  );

  if (!fsList || fsList.length === 0) {
    let emptyText = `✨ — ⚡ *FLASH SALE ZONE* ⚡ — ✨\n\n🚀 Buruan! Stok terbatas dan waktu berjalan.\n🕛 _Update Otomatis (WIB)_\n━━━━━━━━━━━━━━━━━━\n\n😔 Belum ada promo aktif...\n\n━━━━━━━━━━━━━━━━━━\n💡 _Gunakan tombol Refresh untuk update waktu. ${moment.tz("Asia/Jakarta").format("HH:mm")}_\n`;
    return ctx
      .editMessageCaption(emptyText, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[refreshBtn, ...backBtn]]),
      })
      .catch(() =>
        ctx
          .editMessageText(emptyText, {
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard([[refreshBtn, ...backBtn]]),
          })
          .catch(() => { }),
      );
  }

  const store = readDB(db_path.store);
  let activeFs = [];
  let now = Date.now();

  fsList.forEach((fs) => {
    if (now <= fs.expiresAt && fs.usedCount < fs.maxUses) {
      const p = store.products.find((x) => x.id === fs.productId);
      if (p && p.stocks.length > 0) activeFs.push({ fs, p });
    }
  });

  if (activeFs.length === 0) {
    let emptyText = `✨ — ⚡ *FLASH SALE ZONE* ⚡ — ✨\n\n🚀 Buruan! Stok terbatas dan waktu berjalan.\n🕛 _Update Otomatis (WIB)_\n━━━━━━━━━━━━━━━━━━\n\n😔 Promo Flash Sale sedang habis atau stok kosong. Coba lagi nanti! ⚡\n\n━━━━━━━━━━━━━━━━━━\n💡 _Gunakan tombol Refresh untuk update waktu. ${moment.tz("Asia/Jakarta").format("HH:mm")}_\n`;
    return ctx
      .editMessageCaption(emptyText, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[refreshBtn, ...backBtn]]),
      })
      .catch(() =>
        ctx
          .editMessageText(emptyText, {
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard([[refreshBtn, ...backBtn]]),
          })
          .catch(() => { }),
      );
  }

  let text = `✨ — ⚡ *FLASH SALE ZONE* ⚡ — ✨\n\n🚀 Buruan! Stok terbatas dan waktu berjalan.\n🕛 _Update Otomatis (WIB)_\n━━━━━━━━━━━━━━━━━━\n\n`;
  let buttons = [];

  activeFs.forEach((item, idx) => {
    const { fs, p } = item;
    const sisaWaktu = Math.floor((fs.expiresAt - now) / 3600000);
    let sisaMenit = Math.floor(((fs.expiresAt - now) % 3600000) / 60000);
    const sisaKuota = fs.maxUses - fs.usedCount;

    let finalPrice = p.price;
    if (fs.discount.includes("%")) {
      finalPrice = p.price - (p.price * parseInt(fs.discount)) / 100;
    } else {
      finalPrice = p.price - parseInt(fs.discount);
    }
    let displayPrice = `~Rp ${p.price.toLocaleString("id-ID")}~ -> *Rp ${finalPrice.toLocaleString("id-ID")}*`;

    text += `🛒 *${p.name}*\n┣ 💰 ${displayPrice}\n┣ ⚡ Sisa Kuota: ${sisaKuota} Orang\n┣ ⏳ Sisa Waktu: ${sisaWaktu} Jam ${sisaMenit} Menit\n┗ 📦 Stok Gudang: ${p.stocks.length}\n\n`;
    buttons.push([
      Markup.button.callback(
        `⚡ Beli ${p.name.substring(0, 15)} (Rp${finalPrice.toLocaleString("id-ID")})`,
        `v_${p.id}_1`,
      ),
    ]);
  });

  text += `━━━━━━━━━━━━━━━━━━\n💡 _Gunakan tombol Refresh untuk update waktu. ${moment.tz("Asia/Jakarta").format("HH:mm")}_`;

  buttons.push([refreshBtn, ...backBtn]);

  try {
    await ctx.editMessageCaption(text, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard(buttons),
    });
  } catch (e) {
    await ctx
      .editMessageText(text, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard(buttons),
      })
      .catch(() => { });
  }
});

bot.hears("👤 Profil", (ctx) => {
  userState.delete(ctx.from.id);
  const u = readDB(db_path.user).find(
    (x) => String(x.id) === String(ctx.from.id),
  );
  if (!u) return ctx.reply("Gunakan /start terlebih dahulu.");

  const safeNameHtml = sanitizeHTML(u.name);
  const text = `👤 <b>PROFIL PENGGUNA</b>\n━━━━━━━━━━━━━━━━━━\n🆔 ID: <code>${u.id}</code>\n👤 Nama: ${safeNameHtml}\n💳 Saldo: <b>Rp ${u.balance.toLocaleString()}</b>\n📅 Bergabung: ${u.joined}\n━━━━━━━━━━━━━━━━━━`;

  ctx.reply(text, { parse_mode: "HTML" });
});
bot.hears("📊 Stok Produk", (ctx) => {
  userState.delete(ctx.from.id);
  const s = readDB(db_path.store);
  if (s.categories.length === 0) return ctx.reply("Gudang kosong.");
  let t = "📊 *STOK PRODUK TERSEDIA*\n━━━━━━━━━━━━━━━━━━\n\n";
  let sortedCats = [...s.categories].sort((a, b) => {
    const stockA = s.products
      .filter((p) => p.category === a)
      .reduce((sum, p) => sum + p.stocks.length, 0);
    const stockB = s.products
      .filter((p) => p.category === b)
      .reduce((sum, p) => sum + p.stocks.length, 0);
    if (stockA > 0 && stockB === 0) return -1;
    if (stockA === 0 && stockB > 0) return 1;
    return a.localeCompare(b);
  });

  sortedCats.forEach((c) => {
    const prodInCategory = s.products.filter((p) => p.category === c);
    if (prodInCategory.length > 0) {
      t += `📁 *${c.toUpperCase()}*\n`;
      prodInCategory.forEach(
        (p) => (t += `  - ${p.name}: *${p.stocks.length}*\n`),
      );
      t += "\n";
    }
  });
  ctx.reply(t, { parse_mode: "Markdown" });
});

bot.hears("📈 Statistik", (ctx) => {
  userState.delete(ctx.from.id);
  const trxs = readDB(db_path.trx);
  const successTrxs = trxs.filter((x) => x.status === "success");
  const users = readDB(db_path.user);

  let totalRevenue = 0;
  successTrxs.forEach((t) => (totalRevenue += t.amount || 0));

  let res = "📈 *STATISTIK TOKO*\n━━━━━━━━━━━━━━━━━━\n\n";
  res += `👥 Total User: *${users.length}*\n`;
  res += `🧾 Total Transaksi: *${trxs.length}*\n`;
  res += `✅ Transaksi Sukses: *${successTrxs.length}*\n`;
  res += `💰 Total Omset: *Rp ${totalRevenue.toLocaleString()}*\n`;
  res += `━━━━━━━━━━━━━━━━━━`;

  ctx.reply(res, { parse_mode: "Markdown" });
});
bot.hears("🎟️ Voucher & Promo", (ctx) => {
  if (String(ctx.from.id) !== OWNER_ID) return;
  userState.delete(ctx.from.id);
  ctx.reply(
    "🎟 *Pusat Voucher & Promosi*\nSilahkan pilih menu manajemen voucher di bawah ini:",
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("➕ Buat Voucher Baru", "adm_vouch_add")],
        [Markup.button.callback("📋 Kelola Voucher Aktif", "adm_vouch_list")],
      ]),
    },
  );
});

bot.hears("⚡ Set Flash Sale", async (ctx) => {
  if (String(ctx.from.id) !== OWNER_ID) return;
  userState.delete(ctx.from.id);
  const store = readDB(db_path.store);
  const cats = [...new Set(store.categories)].sort();
  if (cats.length === 0) return ctx.reply("Belum ada kategori.", kbAdmin);

  let buttons = [];
  cats.forEach((c) => {
    buttons.push([
      Markup.button.callback(`📁 ${c.toUpperCase()}`, `fs_get_c_${hashC(c)}`),
    ]);
  });
  buttons.push([
    Markup.button.callback("📋 Kelola Flash Sale Aktif", "adm_fs_list"),
  ]);

  await ctx.reply(
    "⚡ *Pusat Flash Sale*\nPilih kategori produk yang ingin didiskon kilat:",
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard(buttons),
    },
  );
});

bot.hears("📜 Riwayat", async (ctx) => {
  try {
    userState.delete(ctx.from.id);
    const allTrx = readDB(db_path.trx);
    if (!Array.isArray(allTrx))
      return ctx.reply("❌ Database riwayat bermasalah.");
    const tx = allTrx
      .filter((x) => String(x.userId) === String(ctx.from.id))
      .slice(-10)
      .reverse();
    if (tx.length === 0)
      return ctx.reply(
        "📜 *RIWAYAT TRANSAKSI*\n━━━━━━━━━━━━━━━━━━\n\nBelum ada riwayat transaksi.",
        { parse_mode: "Markdown" },
      );
    let res = "📜 *10 RIWAYAT TERAKHIR*\n━━━━━━━━━━━━━━━━━━\n\n";
    tx.forEach((t) => {
      const orderId = t.orderId || "N/A";
      const status = (t.status || "UNKNOWN").toUpperCase();
      const amount =
        typeof t.amount === "number" ? t.amount.toLocaleString() : "0";
      const type = (t.type || "N/A").toUpperCase();
      res += `▫️ \`${orderId}\` | ${status}\n   💰 Rp ${amount} | 💳 ${type}\n\n`;
    });
    await ctx.reply(res, { parse_mode: "Markdown" });
  } catch (e) {
    log.error("Gagal memuat Riwayat", e);
    ctx.reply("❌ Terjadi kesalahan saat mengambil data riwayat.");
  }
});

bot.hears("💳 Isi Saldo", (ctx) => {
  userState.delete(ctx.from.id);
  ctx.reply(
    "Silahkan pilih nominal di bawah atau ketik perintah:\n`/topup [nominal]`\nContoh: `/topup 50000`",
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("Rp 5.000", "tu_5000"),
          Markup.button.callback("Rp 10.000", "tu_10000"),
        ],
        [
          Markup.button.callback("Rp 20.000", "tu_20000"),
          Markup.button.callback("Rp 50.000", "tu_50000"),
        ],
      ]),
    },
  );
});

bot.hears("📞 Hubungi Admin", (ctx) => {
  userState.set(ctx.from.id, { step: "ask_support" });
  ctx.reply(
    "☎️ *LAYANAN BANTUAN LIVE*\n\nSilahkan ketik pesan/kendala Anda di bawah ini.\nAdmin akan segera merespon secara langsung.",
    {
      parse_mode: "Markdown",
      ...Markup.keyboard([["🔙 Menu Utama"]]).resize(),
    },
  );
});

bot.hears("🛠 Menu Admin", (ctx) => {
  if (String(ctx.from.id) !== OWNER_ID) return;
  userState.delete(ctx.from.id);
  ctx.reply("🛠 *ADMIN PANEL*", kbAdmin);
});

bot.hears("🔙 Menu Admin", (ctx) => {
  if (String(ctx.from.id) !== OWNER_ID) return;
  userState.delete(ctx.from.id);
  ctx.reply("Kembali ke Panel Admin:", kbAdmin);
});

bot.hears("➕ Tambah Data", (ctx) => {
  if (String(ctx.from.id) !== OWNER_ID) return;
  userState.delete(ctx.from.id);
  ctx.reply("Pusat Tambah Data:\nSilakan pilih opsi yang tersedia.", kbAddMenu);
});

bot.hears("✏️ Edit Data", (ctx) => {
  if (String(ctx.from.id) !== OWNER_ID) return;
  userState.delete(ctx.from.id);
  ctx.reply("Pusat Edit Data:\nSilakan pilih opsi yang tersedia.", kbEditMenu);
});

bot.hears("📦 Kelola Stok", (ctx) => {
  if (String(ctx.from.id) !== OWNER_ID) return;
  userState.delete(ctx.from.id);
  ctx.reply(
    "Pusat Manajemen Stok:\nSilakan pilih opsi yang tersedia.",
    kbStockMenu,
  );
});

bot.hears("🎟️ Promo & Diskon", (ctx) => {
  if (String(ctx.from.id) !== OWNER_ID) return;
  userState.delete(ctx.from.id);
  ctx.reply(
    "Pusat Promo dan Diskon:\nSilakan pilih opsi yang tersedia.",
    kbPromoMenu,
  );
});

bot.hears("➕ Kategori", (ctx) => {
  if (String(ctx.from.id) === OWNER_ID) {
    userState.set(ctx.from.id, { step: "adm_cat" });
    ctx.reply(
      "Ketik Nama Kategori Baru dan Deskripsi (Format: Nama Kategori|Deskripsi Kategori):",
    );
  }
});
bot.hears("➕ Produk", (ctx) => {
  if (String(ctx.from.id) === OWNER_ID) {
    userState.set(ctx.from.id, { step: "adm_prod" });
    ctx.reply(
      "Format: `Kategori|Nama|Harga|Deskripsi|Pesan_sukses|HargaGrosir|MinimalBeliGrosir`\n\n_Catatan:_ Dua bagian terakhir opsional.\nContoh Grosir:\n`Diamond|5 DM|5000||Terkirim|4000|5`",
      { parse_mode: "Markdown" },
    );
  }
});
bot.hears("➕ Isi Stok", (ctx) => {
  if (String(ctx.from.id) !== OWNER_ID) return;
  const store = readDB(db_path.store);
  const activeCats = [
    ...new Set(store.products.map((p) => p.category).filter(Boolean)),
  ].sort();
  if (activeCats.length === 0)
    return ctx.reply("❌ Belum ada kategori yang memiliki produk tersimpan.");

  let buttons = [];
  activeCats.forEach((c) => {
    const encodedCat = hashC(c);
    buttons.push([
      Markup.button.callback(`📁 ${c}`, `admstck_c_${encodedCat}`),
    ]);
  });

  ctx.reply("📦 *Pilih Kategori Produk untuk Isi Stok:*", {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard(buttons),
  });
});
bot.hears("🔑 Ambil Stok", (ctx) => {
  if (String(ctx.from.id) !== OWNER_ID) return;
  const store = readDB(db_path.store);
  const activeCats = [
    ...new Set(store.products.map((p) => p.category).filter(Boolean)),
  ].sort();
  if (activeCats.length === 0)
    return ctx.reply("❌ Belum ada produk tersimpan.");
  let buttons = [];
  activeCats.forEach((c) => {
    const encodedCat = hashC(c);
    buttons.push([Markup.button.callback(`📁 ${c}`, `d_get_c_${encodedCat}`)]);
  });
  ctx.reply("🔑 *Pilih Kategori Produk untuk Ambil Stok:*", {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard(buttons),
  });
});

// --- FITUR HAPUS BARU ---
bot.hears("🗑️ Hapus Data", (ctx) => {
  if (String(ctx.from.id) !== OWNER_ID) return;
  ctx.reply(
    "🗑️ *MENU PENGHAPUSAN DATA*\nSilahkan pilih data yang ingin dihapus:",
    { parse_mode: "Markdown", ...kbDeleteMenu },
  );
});

bot.hears("➖ Hapus Kategori", (ctx) => {
  if (String(ctx.from.id) !== OWNER_ID) return;
  const s = readDB(db_path.store);
  if (s.categories.length === 0) return ctx.reply("Belum ada kategori.");
  userState.set(ctx.from.id, { step: "adm_del_cat" });
  let text =
    "🗑️ *PILIH KATEGORI UNTUK DIHAPUS*\nKetik nama kategori yang ingin dihapus:\n\n";
  s.categories.forEach((c, i) => (text += `${i + 1}. \`${c}\`\n`));
  ctx.reply(text, { parse_mode: "Markdown" });
});

bot.hears("➖ Hapus Produk", (ctx) => {
  if (String(ctx.from.id) !== OWNER_ID) return;
  const store = readDB(db_path.store);
  const activeCats = [
    ...new Set(store.products.map((p) => p.category).filter(Boolean)),
  ].sort();
  if (activeCats.length === 0)
    return ctx.reply("❌ Belum ada produk tersimpan.");
  let buttons = [];
  activeCats.forEach((c) => {
    const encodedCat = hashC(c);
    buttons.push([Markup.button.callback(`📁 ${c}`, `d_delp_c_${encodedCat}`)]);
  });
  ctx.reply("🗑️ *Pilih Kategori dari Produk yang ingin dihapus:*", {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard(buttons),
  });
});

bot.hears("✏️ Edit Kategori", (ctx) => {
  if (String(ctx.from.id) !== OWNER_ID) return;
  const store = readDB(db_path.store);
  if (!store.categories || store.categories.length === 0)
    return ctx.reply("❌ Belum ada kategori tersimpan.");

  let buttons = [];
  store.categories.forEach((c) => {
    buttons.push([Markup.button.callback(`✏️ ${c}`, `edit_c_${hashC(c)}`)]);
  });
  ctx.reply("✏️ *Pilih Kategori yang ingin diedit:*", {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard(buttons),
  });
});

bot.action(/^edit_c_(.*)$/, async (ctx) => {
  if (String(ctx.from.id) !== OWNER_ID) return;
  const catName = findC(ctx.match[1], readDB(db_path.store).categories);
  userState.set(ctx.from.id, { step: "adm_edit_cat", catName: catName });
  await ctx.deleteMessage().catch(() => { });
  const s = readDB(db_path.store);
  const catDesc =
    s.category_details && s.category_details[catName]
      ? s.category_details[catName]
      : "Deskripsi Kosong";
  ctx.reply(
    `✏️ Masukkan Nama Kategori dan Deskripsi baru untuk *${catName}*\nFormat: \`NamaBaru|DeskripsiBaru\`\nContoh data yang ada:\n\`${catName}|${catDesc}\``,
    {
      parse_mode: "Markdown",
      ...Markup.keyboard([["🔙 Menu Admin"]]).resize(),
    },
  );
});

bot.hears("✏️ Edit Produk", (ctx) => {
  if (String(ctx.from.id) !== OWNER_ID) return;
  const store = readDB(db_path.store);
  const activeCats = [
    ...new Set(store.products.map((p) => p.category).filter(Boolean)),
  ].sort();
  if (activeCats.length === 0)
    return ctx.reply("❌ Belum ada produk tersimpan.");

  let buttons = [];
  activeCats.forEach((c) => {
    buttons.push([Markup.button.callback(`📁 ${c}`, `editp_c_${hashC(c)}`)]);
  });
  ctx.reply("✏️ *Pilih Kategori dari Produk yang ingin diedit:*", {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard(buttons),
  });
});

bot.action(/^editp_c_(.*)$/, async (ctx) => {
  if (String(ctx.from.id) !== OWNER_ID) return;
  const store = readDB(db_path.store);
  const activeCats = [
    ...new Set(store.products.map((p) => p.category).filter(Boolean)),
  ];
  const catName = findC(ctx.match[1], activeCats);
  const prods = store.products.filter((p) => p.category === catName);

  if (prods.length === 0)
    return ctx.answerCbQuery("Kategori ini kosong.", true).catch(() => { });

  let buttons = [];
  prods.forEach((p) => {
    buttons.push([Markup.button.callback(`🏷 ${p.name}`, `editp_p_${p.id}`)]);
  });
  await ctx.editMessageText(
    `✏️ *Pilih Produk dalam kategori ${catName} yang ingin diedit:*`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) },
  );
});

bot.action(/^editp_p_(.*)$/, async (ctx) => {
  if (String(ctx.from.id) !== OWNER_ID) return;
  const pId = ctx.match[1];
  const store = readDB(db_path.store);
  const p = store.products.find((x) => x.id === pId);
  if (!p)
    return ctx
      .answerCbQuery("❌ Produk tidak ditemukan.", true)
      .catch(() => { });

  userState.set(ctx.from.id, { step: "adm_edit_prod", pId: p.id });
  await ctx.deleteMessage().catch(() => { });
  ctx.reply(
    `✏️ Masukkan Data Baru untuk *${p.name}*\nFormat: \`Kategori|NamaBaru|HargaBaru|DeskripsiBaru|PesanSuksesBaru|HargaGrosir|MinimalGrosir\`\nContoh data yang ada:\n\`${p.category}|${p.name}|${p.price}|${p.desc}|${p.success_msg}|${p.grosir_price || ""}|${p.grosir_min || ""}\``,
    {
      parse_mode: "Markdown",
      ...Markup.keyboard([["🔙 Menu Admin"]]).resize(),
    },
  );
});

bot.hears("➖ Kosongkan Stok", (ctx) => {
  if (String(ctx.from.id) !== OWNER_ID) return;
  const store = readDB(db_path.store);
  if (!store.categories || store.categories.length === 0)
    return ctx.reply("❌ Belum ada kategori tersimpan.");
  let buttons = [];
  store.categories.forEach((c) => {
    const encodedCat = hashC(c);
    buttons.push([Markup.button.callback(`📁 ${c}`, `d_dels_c_${encodedCat}`)]);
  });
  ctx.reply("🧹 *Pilih Kategori dari Produk yang stoknya ingin dikosongkan:*", {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard(buttons),
  });
});

bot.hears("⚙️ Set Sticker", (ctx) => {
  if (String(ctx.from.id) === OWNER_ID) {
    ctx.reply("⚙️ *PENGATURAN STIKER*", {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("✅ Stiker Sukses", "set_stk_success")],
        [Markup.button.callback("❌ Stiker Batal", "set_stk_cancel")],
      ]),
    });
  }
});

bot.hears("💰 Kelola Saldo", (ctx) => {
  if (String(ctx.from.id) === OWNER_ID) {
    userState.set(ctx.from.id, { step: "adm_saldo" });
    ctx.reply(
      "Kelola saldo user.\n\nFormat: `add/sub [ID_USER] [NOMINAL]`\nContoh: `add 1234567 10000` ",
    );
  }
});

bot.hears("📢 Broadcast", (ctx) => {
  if (String(ctx.from.id) === OWNER_ID) {
    userState.set(ctx.from.id, { step: "adm_bc" });
    ctx.reply("Kirim pesan yang ingin di-broadcast ke seluruh user:");
  }
});

bot.hears("📂 Backup Data", async (ctx) => {
  if (String(ctx.from.id) !== OWNER_ID) return;
  const waitMsg = await ctx.reply("⏳ Menyiapkan backup sistem via ZIP...");
  try {
    const zip = new AdmZip();

    // Add explicit files requested by the user
    const targetFiles = [
      "balz.js",
      "fix.js",
      "index.js",
      "main.js",
      "package.json",
      "setting.js",
    ];
    targetFiles.forEach((file) => {
      const p = path.join(__dirname, file);
      if (fs.existsSync(p)) zip.addLocalFile(p);
    });

    // Add directories requested by the user
    const targetDirs = ["database", "function", "options"];
    targetDirs.forEach((dir) => {
      const p = path.join(__dirname, dir);
      if (fs.existsSync(p)) zip.addLocalFolder(p, dir);
    });

    const buffer = zip.toBuffer();
    const timestamp = moment().format("YYYYMMDD_HHmmss");

    await ctx.replyWithDocument(
      {
        source: buffer,
        filename: `Backup_Bot_${timestamp}.zip`,
      },
      {
        caption:
          "✅ *BACKUP SUKSES*\n\nBerikut adalah cadangan file dan database bot Anda.",
        parse_mode: "Markdown",
      },
    );

    await ctx.deleteMessage(waitMsg.message_id).catch(() => { });
  } catch (e) {
    log.error("Gagal backup", e);
    ctx.reply("❌ Terjadi kesalahan saat membuat file zip backup.");
    await ctx.deleteMessage(waitMsg.message_id).catch(() => { });
  }
});

bot.hears("🔙 Menu Utama", async (ctx) => {
  const id = ctx.from.id;
  if (activeChats.has(id)) {
    const target = activeChats.get(id);
    activeChats.delete(id);
    activeChats.delete(target);
    bot.telegram.sendMessage(
      target,
      "🛑 Sesi bantuan telah diakhiri oleh lawan bicara.\nKetik /start untuk membuka menu utama.",
      String(target) === OWNER_ID ? kbAdmin : Markup.removeKeyboard(),
    );
  }
  userState.delete(id);
  await ctx.reply("Memuat Menu Utama...", Markup.removeKeyboard());
  const u = readDB(db_path.user);
  const user = u.find((x) => String(x.id) === String(id));
  if (user) {
    const { text, kb } = getStartMessage(
      ctx,
      user,
      u.length,
      readDB(db_path.trx),
    );
    try {
      await ctx.replyWithPhoto(
        { source: THUMBNAIL },
        { caption: text, parse_mode: "HTML", ...kb },
      );
    } catch (e) {
      await ctx.reply(text, { parse_mode: "HTML", ...kb });
    }
  }
});

// === ACTION CALLBACKS ===

const getFlashSaleText = () => {
  const timeStr = moment.tz("Asia/Jakarta").format("HH:mm");
  return `✨ — ⚡ *FLASH SALE ZONE* ⚡ — ✨\n\n🚀 *Buruan! Stok terbatas dan waktu berjalan.*\n🕛 _Update Otomatis (WIB)_\n━━━━━━━━━━━━━━━━━━\n\n😴 Belum ada promo aktif...\n\n━━━━━━━━━━━━━━━━━━\n💡 _Gunakan tombol Refresh untuk update waktu._  ${timeStr}`;
};

bot.action("menu_flash_sale", async (ctx) => {
  const text = getFlashSaleText();
  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback("🔄 Refresh Waktu", "refresh_flash_sale"),
      Markup.button.callback("🏠 Menu Utama", "back_to_home"),
    ],
  ]);
  try {
    await ctx
      .editMessageCaption(text, { parse_mode: "Markdown", ...kb })
      .catch(() =>
        ctx.editMessageText(text, { parse_mode: "Markdown", ...kb }),
      );
  } catch (e) { }
});

bot.action("refresh_flash_sale", async (ctx) => {
  const text = getFlashSaleText();
  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback("🔄 Refresh Waktu", "refresh_flash_sale"),
      Markup.button.callback("🏠 Menu Utama", "back_to_home"),
    ],
  ]);
  try {
    await ctx
      .editMessageCaption(text, { parse_mode: "Markdown", ...kb })
      .catch(() =>
        ctx.editMessageText(text, { parse_mode: "Markdown", ...kb }),
      );
    await ctx.answerCbQuery("Diperbarui!", false);
  } catch (e) {
    // If content is the same, Telegram throws an error, we just answer the callback
    await ctx.answerCbQuery("Sudah versi terbaru!", false).catch(() => { });
  }
});

const getCatalogPage = (pageStr, cats, products) => {
  cats = [...cats].sort((a, b) => {
    const stockA = products
      .filter((p) => p.category === a)
      .reduce((sum, p) => sum + p.stocks.length, 0);
    const stockB = products
      .filter((p) => p.category === b)
      .reduce((sum, p) => sum + p.stocks.length, 0);
    if (stockA > 0 && stockB === 0) return -1;
    if (stockA === 0 && stockB > 0) return 1;
    return a.localeCompare(b);
  });
  const page = parseInt(pageStr) || 1;
  const limit = 10;
  const totalItems = cats.length;
  const totalPages = Math.ceil(totalItems / limit) || 1;
  const currentPage = Math.min(Math.max(1, page), totalPages);

  const startIndex = (currentPage - 1) * limit;
  const endIndex = Math.min(startIndex + limit, totalItems);
  const pageCats = cats.slice(startIndex, endIndex);

  let text = `✨ *KATALOG PRODUK UTAMA* ✨\n\n📖 Hal: ${currentPage} dari ${totalPages} | 📦 Item: ${totalItems}\n`;

  if (pageCats.length === 0) {
    text +=
      "\`━━━━━━━━━━━━━━━━━━\`\n_Belum ada produk._\n\`━━━━━━━━━━━━━━━━━━\`\n\n";
  } else {
    let buttonsRow1 = [];
    let buttonsRow2 = [];

    text += `\`━━━━━━━━━━━━━━━━━━\`\n`;
    pageCats.forEach((cName, idx) => {
      const globalNumber = startIndex + idx + 1;
      const localNumber = idx + 1;

      const prodsInCat = products.filter((p) => p.category === cName);
      let totalStock = 0;
      prodsInCat.forEach((p) => (totalStock += p.stocks.length));

      text += `${globalNumber}. ${cName.toUpperCase()}\n   ↳ Tersedia: ${totalStock > 0 ? totalStock : "HABIS ❌"}\n`;
      if (idx !== pageCats.length - 1) text += `\n`;

      const encodedName = hashC(cName);
      const btn = Markup.button.callback(
        String(globalNumber),
        `c_${encodedName}`,
      );
      if (localNumber <= 5) buttonsRow1.push(btn);
      else buttonsRow2.push(btn);
    });

    text += `\`━━━━━━━━━━━━━━━━━━\`\n💡 _Pilih nomor di bawah untuk lihat detail._`;

    let kbArray = [];
    if (buttonsRow1.length > 0) kbArray.push(buttonsRow1);
    if (buttonsRow2.length > 0) kbArray.push(buttonsRow2);

    let navRow = [];
    if (currentPage > 1)
      navRow.push(
        Markup.button.callback("⬅️ Prev", `katalog_page_${currentPage - 1}`),
      );
    if (currentPage < totalPages)
      navRow.push(
        Markup.button.callback("Next ➡️", `katalog_page_${currentPage + 1}`),
      );
    if (navRow.length > 0) kbArray.push(navRow);

    kbArray.push([
      Markup.button.callback("⚡ FLASH SALE", "menu_flash_sale"),
      Markup.button.callback("🔥 POPULER", "menu_populer"),
    ]);
    kbArray.push([
      Markup.button.callback("🏠 KEMBALI KE MENU UTAMA", "back_to_home"),
    ]);

    return { text, kb: Markup.inlineKeyboard(kbArray) };
  }

  const fallbackKb = Markup.inlineKeyboard([
    [
      Markup.button.callback("⚡ FLASH SALE", "menu_flash_sale"),
      Markup.button.callback("🔥 POPULER", "menu_populer"),
    ],
    [Markup.button.callback("🏠 KEMBALI KE MENU UTAMA", "back_to_home")],
  ]);
  return { text, kb: fallbackKb };
};

bot.action("menu_belanja", async (ctx) => {
  userState.delete(ctx.from.id);
  const s = readDB(db_path.store);
  const cats = [...new Set(s.categories)].sort();
  const { text, kb } = getCatalogPage(1, cats, s.products);
  try {
    await ctx
      .editMessageCaption(text, { parse_mode: "Markdown", ...kb })
      .catch(() =>
        ctx.editMessageText(text, { parse_mode: "Markdown", ...kb }),
      );
  } catch (e) { }
});

bot.action(/^katalog_page_(.*)$/, async (ctx) => {
  const page = ctx.match[1];
  const s = readDB(db_path.store);
  const cats = [...new Set(s.categories)].sort();
  const { text, kb } = getCatalogPage(page, cats, s.products);
  try {
    await ctx
      .editMessageCaption(text, { parse_mode: "Markdown", ...kb })
      .catch(() =>
        ctx.editMessageText(text, { parse_mode: "Markdown", ...kb }),
      );
    await ctx.answerCbQuery();
  } catch (e) {
    await ctx.answerCbQuery("Sudah di halaman ini.", false).catch(() => { });
  }
});

bot.action(/^c_(.*)$/, async (ctx) => {
  try {
    const s = readDB(db_path.store);
    const catName = findC(ctx.match[1], s.categories);
    const trxs = readDB(db_path.trx);

    let prods = s.products.filter((p) => p.category === catName);
    if (prods.length === 0)
      return ctx.answerCbQuery("⚠️ Kategori ini kosong.", true);

    prods.sort((a, b) => {
      const stockA = a.stocks.length;
      const stockB = b.stocks.length;
      if (stockA > 0 && stockB === 0) return -1;
      if (stockA === 0 && stockB > 0) return 1;
      return a.name.localeCompare(b.name);
    });

    const successTrxs = trxs.filter((x) => x.status === "success");
    let totalSoldCat = 0;
    prods.forEach((p) => {
      const soldForProduct = successTrxs
        .filter((tx) => tx.productId === p.id)
        .reduce((sum, tx) => sum + (tx.qty || 1), 0);
      totalSoldCat += soldForProduct;
    });

    const firstProdDesc =
      prods[0].desc && prods[0].desc !== "-"
        ? prods[0].desc
        : "Promo eksklusif! Cek varian di bawah ini.";
    const timeStr = moment.tz("Asia/Jakarta").format("HH.mm.ss [WIB]");

    let catDesc = "-";
    if (
      catName &&
      s.category_details &&
      s.category_details[catName.toUpperCase()]
    ) {
      catDesc = s.category_details[catName.toUpperCase()];
    } else if (
      prods.length > 0 &&
      prods[0].desc &&
      prods[0].desc.trim() !== ""
    ) {
      catDesc = prods[0].desc;
    }

    let safeCatName = catName ? sanitizeMD(catName.toUpperCase()) : "KATEGORI";
    let safeCatDesc = sanitizeMD(catDesc).trim() || "-";

    let text = `🛍️ *PRODUK:* ${safeCatName}\n📈 *Terjual:* ${totalSoldCat}\n━━━━━━━━━━━━━━━━━━\n📝 *Deskripsi:*\n_${safeCatDesc}_\n━━━━━━━━━━━━━━━━━━\n✨ *VARIANT PRODUCT:*\n\n`;

    let variantButtons = [];
    prods.forEach((p, i) => {
      const stock = p.stocks ? p.stocks.length : 0;
      const safePName = sanitizeMD(p.name ? p.name.toUpperCase() : "PRODUK");
      const price = p.price || 0;

      text += `▫️ ${i + 1}. *${safePName}*\n   ↳ Rp ${price.toLocaleString("id-ID")} — Stok: ${stock > 0 ? stock : "HABIS ❌"}\n\n`;

      if (stock > 0) {
        variantButtons.push([
          Markup.button.callback(
            `${p.name.toUpperCase()} - Rp ${price.toLocaleString("id-ID")}`,
            `v_${p.id}_1`,
          ),
        ]);
      } else {
        variantButtons.push([
          Markup.button.callback(
            `📢 Kabari Saya saat Restock`,
            `notify_restock_${p.id}`,
          ),
        ]);
      }
    });

    text += `━━━━━━━━━━━━━━━━━━\n🕛 _Refreshed at ${timeStr}_\n`;

    let b = [...variantButtons];
    b.push([
      Markup.button.callback("🔄 Refresh", `c_${ctx.match[1]}`),
      Markup.button.callback("⬅️ Back", "back_to_shop"),
    ]);
    b.push([Markup.button.callback("📦 Back To Product", "back_to_shop")]);

    try {
      await ctx.editMessageCaption(text, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard(b),
      });
    } catch (e) {
      await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard(b),
      });
    }
    await ctx.answerCbQuery().catch(() => { });
  } catch (err) {
    ctx.answerCbQuery("⚠️ Gagal memuat detail produk.", true).catch(() => { });
  }
});

const getPopularPage = (pageStr, products, trxs) => {
  const page = parseInt(pageStr) || 1;
  const limit = 10;

  const successTrxs = trxs.filter(
    (x) => x.status === "success" && x.type === "direct",
  );

  let stats = products
    .map((p) => {
      let soldQty = 0;
      successTrxs
        .filter((tx) => tx.productId === p.id)
        .forEach((tx) => {
          soldQty += tx.qty || 1;
        });
      return { ...p, soldQty };
    })
    .filter((p) => p.soldQty > 0);

  stats.sort((a, b) => b.soldQty - a.soldQty);

  const totalItems = stats.length;
  const totalPages = Math.ceil(totalItems / limit) || 1;
  const currentPage = Math.min(Math.max(1, page), totalPages);

  const startIndex = (currentPage - 1) * limit;
  const endIndex = Math.min(startIndex + limit, totalItems);
  const pageStats = stats.slice(startIndex, endIndex);

  let text = `🔥 *BEST SELLER - TOP RANKING* 🔥\n━━━━━━━━━━━━━━━━━━\n📊 _Data Berdasarkan Penjualan Terbanyak_\n📁 Hal: ${currentPage} / ${totalPages}\n━━━━━━━━━━━━━━━━━━\n\n`;

  if (pageStats.length === 0) {
    text += "_Belum ada data penjualan._\n\n";
  } else {
    pageStats.forEach((p, idx) => {
      const globalNumber = startIndex + idx + 1;
      let rankIcon = "🔹";
      if (globalNumber === 1) rankIcon = "🥇";
      else if (globalNumber === 2) rankIcon = "🥈";
      else if (globalNumber === 3) rankIcon = "🥉";

      text += `${rankIcon} *RANK #${globalNumber} - ${p.name.toUpperCase()}*\n 📦 Terjual: ${p.soldQty.toLocaleString("id-ID")} unit\n`;
    });
    text += "\n✨ _Produk di atas adalah yang paling sering dicari._";
  }

  let kbArray = [];
  let navRow = [];
  if (currentPage > 1)
    navRow.push(
      Markup.button.callback(
        "⏪ Sebelumnya",
        `populer_page_${currentPage - 1}`,
      ),
    );
  if (currentPage < totalPages)
    navRow.push(
      Markup.button.callback(
        "Berikutnya ⏩",
        `populer_page_${currentPage + 1}`,
      ),
    );
  if (navRow.length > 0) kbArray.push(navRow);

  kbArray.push([
    Markup.button.callback("📦 Katalog Produk", "menu_belanja"),
    Markup.button.callback("⚡ Flash Sale", "menu_flash_sale"),
  ]);
  kbArray.push([Markup.button.callback("🏠 Kembali ke Home", "back_to_home")]);

  return { text, kb: Markup.inlineKeyboard(kbArray) };
};

bot.action("menu_populer", async (ctx) => {
  userState.delete(ctx.from.id);
  const s = readDB(db_path.store);
  const trxs = readDB(db_path.trx);
  const { text, kb } = getPopularPage(1, s.products, trxs);
  try {
    await ctx
      .editMessageCaption(text, { parse_mode: "Markdown", ...kb })
      .catch(() =>
        ctx.editMessageText(text, { parse_mode: "Markdown", ...kb }),
      );
  } catch (e) { }
});

bot.action(/^populer_page_(.*)$/, async (ctx) => {
  const page = ctx.match[1];
  const s = readDB(db_path.store);
  const trxs = readDB(db_path.trx);
  const { text, kb } = getPopularPage(page, s.products, trxs);
  try {
    await ctx
      .editMessageCaption(text, { parse_mode: "Markdown", ...kb })
      .catch(() =>
        ctx.editMessageText(text, { parse_mode: "Markdown", ...kb }),
      );
    await ctx.answerCbQuery();
  } catch (e) {
    await ctx.answerCbQuery("Sudah di halaman ini.", false).catch(() => { });
  }
});

bot.action("menu_topup", async (ctx) => {
  userState.delete(ctx.from.id);
  const text =
    "Silahkan pilih nominal di bawah atau ketik perintah:\n`/topup [nominal]`\nContoh: `/topup 50000`";
  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback("Rp 5.000", "tu_5000"),
      Markup.button.callback("Rp 10.000", "tu_10000"),
    ],
    [
      Markup.button.callback("Rp 20.000", "tu_20000"),
      Markup.button.callback("Rp 50.000", "tu_50000"),
    ],
    [Markup.button.callback("🔙 Menu Utama", "back_to_home")],
  ]);
  try {
    await ctx
      .editMessageCaption(text, { parse_mode: "Markdown", ...kb })
      .catch(() =>
        ctx.editMessageText(text, { parse_mode: "Markdown", ...kb }),
      );
  } catch (e) { }
});

bot.action("menu_populer", async (ctx) => {
  userState.delete(ctx.from.id);
  const s = readDB(db_path.store);
  if (s.categories.length === 0)
    return ctx.answerCbQuery("Gudang kosong.", true);
  let t = "📊 *PRODUK POPULER & STOK*\n━━━━━━━━━━━━━━━━━━\n\n";
  let sortedCats = [...s.categories].sort((a, b) => {
    const stockA = s.products
      .filter((p) => p.category === a)
      .reduce((sum, p) => sum + p.stocks.length, 0);
    const stockB = s.products
      .filter((p) => p.category === b)
      .reduce((sum, p) => sum + p.stocks.length, 0);
    if (stockA > 0 && stockB === 0) return -1;
    if (stockA === 0 && stockB > 0) return 1;
    return a.localeCompare(b);
  });

  sortedCats.forEach((c) => {
    const prodInCategory = s.products.filter((p) => p.category === c);
    if (prodInCategory.length > 0) {
      t += `📁 *${c.toUpperCase()}*\n`;
      prodInCategory.forEach(
        (p) => (t += `  - ${p.name}: *${p.stocks.length}*\n`),
      );
      t += "\n";
    }
  });
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("🔙 Menu Utama", "back_to_home")],
  ]);
  try {
    await ctx
      .editMessageCaption(t, { parse_mode: "Markdown", ...kb })
      .catch(() => ctx.editMessageText(t, { parse_mode: "Markdown", ...kb }));
  } catch (e) { }
});

bot.action("menu_profil", async (ctx) => {
  userState.delete(ctx.from.id);
  const u = readDB(db_path.user).find(
    (x) => String(x.id) === String(ctx.from.id),
  );
  if (!u) return ctx.answerCbQuery("User tidak ditemukan.", true);

  const safeNameHtml = sanitizeHTML(u.name);
  const text = `👤 <b>PROFIL PENGGUNA</b>\n━━━━━━━━━━━━━━━━━━\n🆔 ID: <code>${u.id}</code>\n👤 Nama: ${safeNameHtml}\n💳 Saldo: <b>Rp ${u.balance.toLocaleString()}</b>\n📅 Bergabung: ${u.joined}\n━━━━━━━━━━━━━━━━━━`;

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("🔙 Menu Utama", "back_to_home")],
  ]);
  try {
    await ctx
      .editMessageCaption(text, { parse_mode: "HTML", ...kb })
      .catch(() => ctx.editMessageText(text, { parse_mode: "HTML", ...kb }));
  } catch (e) { }
});

bot.action("menu_admin", async (ctx) => {
  if (String(ctx.from.id) !== OWNER_ID)
    return ctx.answerCbQuery("Akses ditolak.", true);
  userState.delete(ctx.from.id);
  await ctx.reply("🛠 *ADMIN PANEL*", kbAdmin);
});

bot.action("back_to_home", async (ctx) => {
  const u = readDB(db_path.user);
  const user = u.find((x) => String(x.id) === String(ctx.from.id));
  if (!user) return ctx.answerCbQuery("User tidak ditemukan.", true);

  const { text, kb } = getStartMessage(
    ctx,
    user,
    u.length,
    readDB(db_path.trx),
  );
  try {
    await ctx
      .editMessageCaption(text, { parse_mode: "HTML", ...kb })
      .catch(() => ctx.editMessageText(text, { parse_mode: "HTML", ...kb }));
  } catch (e) { }
});

bot.action("back_to_shop", async (ctx) => {
  const s = readDB(db_path.store);
  const cats = [...new Set(s.categories)].sort();
  const { text, kb } = getCatalogPage(1, cats, s.products);
  try {
    await ctx
      .editMessageCaption(text, { parse_mode: "Markdown", ...kb })
      .catch(() =>
        ctx.editMessageText(text, { parse_mode: "Markdown", ...kb }),
      );
  } catch (e) { }
});

bot.action(/^accept_chat_(.*)$/, async (ctx) => {
  const userId = ctx.match[1];
  if (String(ctx.from.id) !== OWNER_ID) return;

  activeChats.set(OWNER_ID, userId);
  activeChats.set(userId, OWNER_ID);
  userState.delete(userId);

  await ctx.answerCbQuery("✅ Chat terhubung!");
  await ctx.editMessageText(
    `✅ Terhubung dengan user \`${userId}\`.\nKetik apa saja untuk membalas, atau kirim media.`,
    { parse_mode: "Markdown" },
  );
  await bot.telegram.sendMessage(
    userId,
    "✅ Admin telah memasuki room chat. Sampaikan kendala Anda secara live sekarang.",
    kbChat,
  );
});

bot.action("set_stk_success", (ctx) => {
  userState.set(ctx.from.id, { step: "adm_set_sticker_success" });
  ctx.answerCbQuery();
  ctx.reply("Silahkan kirim stiker untuk notifikasi *SUKSES*.");
});

bot.action("set_stk_cancel", (ctx) => {
  userState.set(ctx.from.id, { step: "adm_set_sticker_cancel" });
  ctx.answerCbQuery();
  ctx.reply("Silahkan kirim stiker untuk notifikasi *BATAL*.");
});

bot.action(/^check_trx_(.*)$/, async (ctx) => {
  const unlock = await dbMutex.lock();
  try {
    const orderId = ctx.match[1];
    let trxs = readDB(db_path.trx);
    let users = readDB(db_path.user);
    let store = readDB(db_path.store);
    const tx = trxs.find((x) => x.orderId === orderId);
    if (!tx) return ctx.answerCbQuery("❌ Transaksi tidak ditemukan.", true);
    if (tx.status !== "pending")
      return ctx.answerCbQuery("✅ Transaksi ini sudah selesai.", true);

    const status = await checkStatusPakasir(orderId, tx.amount);
    if (status === "PAID") {
      await ctx.answerCbQuery("✅ Pembayaran terdeteksi!", true);
      if (await processDelivery(tx, users, store)) {
        writeDB(db_path.trx, trxs);
        writeDB(db_path.user, users);
        writeDB(db_path.store, store);
        try {
          await ctx.deleteMessage();
        } catch (e) { }
      }
    } else {
      ctx.answerCbQuery("⏳ Pembayaran belum terdeteksi.", true);
    }
  } finally {
    unlock();
  }
});

bot.action(/^tu_(.*)$/, async (ctx) => {
  const nominal = parseInt(ctx.match[1]);
  await ctx.answerCbQuery();
  await createTopupRequest(ctx, nominal);
});

// 1. Menu Detail Produk / Konfirmasi Pesanan
bot.action(/^v_(.*)$/, async (ctx) => {
  try {
    const [_, payload] = ctx.match;
    const [pid, qtyStr] = payload.split("_");
    let qty = parseInt(qtyStr) || 1;

    const s = readDB(db_path.store);
    const p = s.products.find((x) => x.id === pid);

    if (!p) return ctx.answerCbQuery("❌ Produk tidak ditemukan.", true);

    const stockCount = p.stocks.length;
    if (stockCount === 0)
      return ctx.answerCbQuery("⚠️ Stok produk ini sedang kosong.", true);

    if (qty > stockCount) qty = stockCount; // Cap quantity to max stock

    let currentPrice = p.price;
    let isGrosirActive = false;
    if (p.grosir_price && p.grosir_min && qty >= p.grosir_min) {
      currentPrice = p.grosir_price;
      isGrosirActive = true;
    }

    let totalPrice = currentPrice * qty;
    let originalPrice = totalPrice;

    let isFlashSale = false;
    let discountInfo = "";
    const fsList = readDB(db_path.flashsale) || [];
    const fs = fsList.find(
      (x) =>
        x.productId === pid &&
        Date.now() <= x.expiresAt &&
        x.usedCount < x.maxUses,
    );

    if (fs) {
      isFlashSale = true;
      let finalPrice = currentPrice;
      if (fs.discount.includes("%")) {
        finalPrice =
          currentPrice - (currentPrice * parseInt(fs.discount)) / 100;
      } else {
        finalPrice = currentPrice - parseInt(fs.discount);
      }
      if (finalPrice < 0) finalPrice = 0;
      totalPrice = finalPrice * qty;
      discountInfo = `┣ Diskon (⚡ Flash Sale): -Rp ${((currentPrice - finalPrice) * qty).toLocaleString("id-ID")}\n┣ Harga Asli: ~Rp ${originalPrice.toLocaleString("id-ID")}~\n`;
    } else {
      const uState = userState.get(ctx.from.id);
      const activeVoucher = uState?.activeVoucher;

      if (activeVoucher && activeVoucher.discount) {
        let discVal = 0;
        if (activeVoucher.discount.includes("%")) {
          const pct = parseFloat(activeVoucher.discount);
          discVal = Math.floor(originalPrice * (pct / 100));
        } else {
          discVal = parseInt(activeVoucher.discount) || 0;
        }
        totalPrice -= discVal;
        if (totalPrice < 0) totalPrice = 0;
        discountInfo = `┣ Diskon (${activeVoucher.code}): -Rp ${discVal.toLocaleString("id-ID")}\n┣ Harga Asli: ~Rp ${originalPrice.toLocaleString("id-ID")}~\n`;
      }
    }

    const timeStr = moment.tz("Asia/Jakarta").format("HH.mm.ss [WIB]");

    let daftarHargaText = `1+ = Rp ${p.price.toLocaleString("id-ID")}/item ${!isGrosirActive ? "✅" : ""}`;
    if (p.grosir_price && p.grosir_min) {
      daftarHargaText += `\n${p.grosir_min}+ = Rp ${p.grosir_price.toLocaleString("id-ID")}/item ${isGrosirActive ? "✅" : ""}`;
    }

    const text = `✨ *KONFIRMASI PESANAN* ✨\n━━━━━━━━━━━━━━━━━━\n\n📦 *PRODUK:* ${p.category.toUpperCase()}\n🏷 *VARIAN:* ${p.name.toUpperCase()}\nℹ️ *Deskripsi:* ${p.desc || "-"}\n\n━━━━━━━━━━━━━━━━━━\n💰 *DAFTAR HARGA :*\n${daftarHargaText}\n\n📊 *INFORMASI STOK:*\n┣ Tersedia: ${stockCount} unit\n┗ Min. Beli: 1 unit\n\n🛒 *RINCIAN BELANJA:*\n┣ Jumlah: ${qty}x\n┣ Harga Satuan: Rp ${currentPrice.toLocaleString("id-ID")}\n${discountInfo}┗ *TOTAL BAYAR: Rp ${totalPrice.toLocaleString("id-ID")}*\n━━━━━━━━━━━━━━━━━━\n🕛 _Diperbarui pada: ${timeStr}_`;

    let qtyButtons = [];

    // Dynamically build quantity adjustment buttons based on stock
    let topRow = [];
    let bottomRow = [];

    if (qty > 1)
      topRow.push(Markup.button.callback("-1", `v_${pid}_${qty - 1}`));
    if (qty >= 5)
      topRow.push(
        Markup.button.callback("-5", `v_${pid}_${qty > 5 ? qty - 5 : 1}`),
      );
    if (qty >= 10)
      topRow.push(
        Markup.button.callback("-10", `v_${pid}_${qty > 10 ? qty - 10 : 1}`),
      );

    if (stockCount > qty)
      topRow.push(Markup.button.callback("+1", `v_${pid}_${qty + 1}`));

    if (stockCount >= qty + 5)
      bottomRow.push(Markup.button.callback("+5", `v_${pid}_${qty + 5}`));
    if (stockCount >= qty + 10)
      bottomRow.push(Markup.button.callback("+10", `v_${pid}_${qty + 10}`));
    if (stockCount >= qty + 50)
      bottomRow.push(Markup.button.callback("+50", `v_${pid}_${qty + 50}`));

    if (topRow.length > 0) qtyButtons.push(topRow);
    if (bottomRow.length > 0) qtyButtons.push(bottomRow);

    const b = [...qtyButtons];
    if (!isFlashSale)
      b.push([
        Markup.button.callback("🎟 Gunakan Voucher", `vouch_${pid}_${qty}`),
      ]);
    b.push([
      Markup.button.callback(
        `✅ Confirm (Rp${totalPrice.toLocaleString("id-ID")}) - SALDO`,
        `pay_bal_${pid}_${qty}_${totalPrice}`,
      ),
    ]);
    b.push([
      Markup.button.callback(
        `💳 Bayar via QRIS (Rp${totalPrice.toLocaleString("id-ID")})`,
        `pay_qris_${pid}_${qty}_${totalPrice}`,
      ),
    ]);
    b.push([
      Markup.button.callback("🔄 Refresh", `v_${pid}_${qty}`),
      Markup.button.callback("⬅️ Kembali", `c_${hashC(p.category)}`),
    ]);

    try {
      await ctx.editMessageCaption(text, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard(b),
      });
    } catch (e) {
      await ctx
        .editMessageText(text, {
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard(b),
        })
        .catch(() => { });
    }
    await ctx.answerCbQuery().catch(() => { });
  } catch (err) {
    ctx.answerCbQuery("⚠️ Gagal memuat produk.", true).catch(() => { });
  }
});

bot.action(/^vouch_(.*)$/, async (ctx) => {
  userState.set(ctx.from.id, { step: "input_voucher" });
  await ctx.reply("🎟 Silakan ketik *KODE VOUCHER* Anda:", {
    parse_mode: "Markdown",
  });
  await ctx.answerCbQuery();
});

// 2. Checkout handlers (dipanggil langsung dari Confirm Menu)

bot.action(/^pay_bal_(.*)_(.*)_(.*)$/, async (ctx) => {
  const unlock = await dbMutex.lock();
  try {
    const [_, pid, qty, amount] = ctx.match;
    let users = readDB(db_path.user);
    let store = readDB(db_path.store);
    let trxs = readDB(db_path.trx);
    const uIdx = users.findIndex((u) => String(u.id) === String(ctx.from.id));
    const pIdx = store.products.findIndex((p) => p.id === pid);
    if (uIdx === -1 || users[uIdx].balance < parseInt(amount))
      return ctx.answerCbQuery("❌ Saldo tidak cukup!", true);
    if (pIdx === -1 || store.products[pIdx].stocks.length < parseInt(qty))
      return ctx.answerCbQuery("❌ Stok habis!", true);
    users[uIdx].balance -= parseInt(amount);

    const uState = userState.get(ctx.from.id);
    const activeVoucher = uState?.activeVoucher;

    const tx = {
      orderId: `BAL${Date.now()}`,
      userId: ctx.from.id,
      amount: parseInt(amount),
      type: "direct",
      productId: pid,
      productName: store.products[pIdx].name,
      qty: parseInt(qty),
      status: "pending",
      date: moment().format(),
      fsApplied: false,
      voucherApplied: null,
    };
    if (await processDelivery(tx, users, store)) {
      if (tx.status === "success") {
        let fsList = readDB(db_path.flashsale) || [];
        const fsIdx = fsList.findIndex(
          (x) =>
            x.productId === pid &&
            Date.now() <= x.expiresAt &&
            x.usedCount < x.maxUses,
        );
        if (fsIdx !== -1) {
          fsList[fsIdx].usedCount += parseInt(qty);
          writeDB(db_path.flashsale, fsList);
          tx.fsApplied = true;
        }

        if (activeVoucher) {
          tx.voucherApplied = activeVoucher.code;
          let promos = readDB(db_path.promo);
          const vIdx = promos.findIndex((p) => p.code === activeVoucher.code);
          if (vIdx !== -1) {
            if (!promos[vIdx].usedBy) promos[vIdx].usedBy = [];
            promos[vIdx].usedBy.push(ctx.from.id);
            writeDB(db_path.promo, promos);
          }
          userState.set(ctx.from.id, { ...uState, activeVoucher: null });
        }
      }
      trxs.push(tx);
      writeDB(db_path.user, users);
      writeDB(db_path.store, store);
      writeDB(db_path.trx, trxs);

      await ctx.deleteMessage().catch(() => { });
      ctx.answerCbQuery("✅ Transaksi Berhasil!", true);
    } else ctx.answerCbQuery("❌ Terjadi kesalahan.", true);
  } finally {
    unlock();
  }
});

bot.action(/^pay_qris_(.*)_(.*)_(.*)$/, async (ctx) => {
  const unlock = await dbMutex.lock();
  try {
    const [_, pid, qty, amount] = ctx.match;
    const orderId = `INV${Date.now()}`;
    const p = readDB(db_path.store).products.find((x) => x.id === pid);
    if (!p || p.stocks.length < parseInt(qty))
      return ctx.answerCbQuery("Stok habis.", true);
    await ctx.deleteMessage();
    ctx.reply("⌛ Menyiapkan QRIS Pakasir...");

    const uState = userState.get(ctx.from.id);
    const activeVoucher = uState?.activeVoucher;

    try {
      const payload = {
        project: PAKASIR_SLUG,
        order_id: orderId,
        amount: parseInt(amount),
        api_key: PAKASIR_KEY,
      };
      const res = await axios.post(
        "https://app.pakasir.com/api/transactioncreate/qris",
        payload,
        { headers: { "Content-Type": "application/json" }, timeout: 10000 },
      );
      if (res.data && res.data.payment) {
        const qr = await QRCode.toBuffer(res.data.payment.payment_number);

        let fsApplied = false;
        let voucherApplied = null;

        let fsList = readDB(db_path.flashsale) || [];
        const fsIdx = fsList.findIndex(
          (x) =>
            x.productId === pid &&
            Date.now() <= x.expiresAt &&
            x.usedCount < x.maxUses,
        );
        if (fsIdx !== -1) {
          fsList[fsIdx].usedCount += parseInt(qty);
          writeDB(db_path.flashsale, fsList);
          fsApplied = true;
        }

        if (activeVoucher) {
          let promos = readDB(db_path.promo);
          const vIdx = promos.findIndex((p) => p.code === activeVoucher.code);
          if (vIdx !== -1) {
            if (!promos[vIdx].usedBy) promos[vIdx].usedBy = [];
            promos[vIdx].usedBy.push(ctx.from.id);
            writeDB(db_path.promo, promos);
            voucherApplied = activeVoucher.code;
          }
          userState.set(ctx.from.id, { ...uState, activeVoucher: null });
        }

        let txs = readDB(db_path.trx);
        txs.push({
          orderId,
          userId: ctx.from.id,
          amount: parseInt(amount),
          type: "direct",
          productId: pid,
          productName: p.name,
          qty: parseInt(qty),
          status: "pending",
          date: moment().format(),
          fsApplied,
          voucherApplied,
        });
        writeDB(db_path.trx, txs);
        await ctx.replyWithPhoto(
          { source: qr },
          {
            caption: `💳 *PAYMENT QRIS*\n━━━━━━━━━━━━━━━━━━\nTotal: *Rp ${res.data.payment.total_payment.toLocaleString()}*\n\n_Data terkirim otomatis setelah bayar._`,
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard([
              [Markup.button.callback("✅ Cek Manual", `check_trx_${orderId}`)],
              [Markup.button.callback("❌ Batal", `cancel_trx_${orderId}`)],
            ]),
          },
        );
      }
    } catch (e) {
      ctx.reply("❌ Gagal membuat QRIS.");
    }
  } finally {
    unlock();
  }
});

bot.action(/^cancel_trx_(.*)$/, async (ctx) => {
  const orderId = ctx.match[1];
  let txs = readDB(db_path.trx);
  const i = txs.findIndex((x) => x.orderId === orderId);
  if (i !== -1 && txs[i].status === "pending") {
    txs[i].status = "cancelled";
    revertKuota(txs[i]);
    writeDB(db_path.trx, txs);
    await ctx.deleteMessage().catch(() => { });
    await ctx.reply("❌ Pembayaran dibatalkan.");
    await sendCancelSticker(ctx.from.id);
  } else {
    await ctx.answerCbQuery("Pembayaran sudah diproses/dibatalkan.", true);
  }
});

bot.action(/^del_vouch_(.*)$/, async (ctx) => {
  if (String(ctx.from.id) !== OWNER_ID) return;
  const vCode = ctx.match[1];
  let promos = readDB(db_path.promo);
  const initialLen = promos.length;
  promos = promos.filter((p) => String(p.code) !== String(vCode));

  if (promos.length < initialLen) {
    writeDB(db_path.promo, promos);
    await ctx
      .answerCbQuery(`✅ Voucher ${vCode} dihapus!`, true)
      .catch(() => { });
    await ctx.deleteMessage().catch(() => { });
    ctx.reply(`✅ Berhasil menghapus voucher *${vCode}*.`, {
      parse_mode: "Markdown",
    });
  } else {
    await ctx
      .answerCbQuery(`❌ Voucher ${vCode} tidak ditemukan!`, true)
      .catch(() => { });
  }
});

bot.action("adm_vouch_add", async (ctx) => {
  if (String(ctx.from.id) !== OWNER_ID) return;
  userState.set(ctx.from.id, { step: "adm_promo" });
  await ctx.deleteMessage().catch(() => { });
  ctx.reply(
    "🎟 Masukkan pengaturan *Voucher Baru*:\nFormat: `KODE|DISKON|JAM_AKTIF` (Jam)\nContoh: `DISKON20|20%|24` (aktif 24 jam) atau `POTONG10K|10000|72` (aktif 3 hari)",
    {
      parse_mode: "Markdown",
      ...Markup.keyboard([["🔙 Menu Admin"]]).resize(),
    },
  );
});

bot.action("adm_vouch_list", async (ctx) => {
  if (String(ctx.from.id) !== OWNER_ID) return;
  await ctx.answerCbQuery().catch(() => { });
  const promos = readDB(db_path.promo);
  if (!promos || promos.length === 0)
    return ctx.reply("Belum ada voucher yang aktif saat ini.");

  let t = "📋 *DAFTAR VOUCHER AKTIF*\n━━━━━━━━━━━━━━━━━━\n\n";
  let buttons = [];

  promos.forEach((p, idx) => {
    let status = "Selamanya";
    if (p.expiresAt) {
      if (Date.now() > p.expiresAt) status = "🔴 KEDALUWARSA";
      else {
        const sisa = Math.floor((p.expiresAt - Date.now()) / 3600000);
        status = `🟢 Aktif (${sisa} Jam lagi)`;
      }
    }
    t += `${idx + 1}. *${p.code}*\n   📉 Diskon: ${p.discount}\n   ⏳ Status: ${status}\n   👥 Total Dipakai: ${p.usedBy ? p.usedBy.length : 0} kali\n\n`;
    buttons.push([
      Markup.button.callback(`🗑 Hapus ${p.code}`, `del_vouch_${p.code}`),
    ]);
  });

  await ctx
    .editMessageText(t, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard(buttons),
    })
    .catch(() => { });
});

bot.action("adm_fs_list", async (ctx) => {
  if (String(ctx.from.id) !== OWNER_ID) return;
  await ctx.answerCbQuery().catch(() => { });
  const fsList = readDB(db_path.flashsale);
  if (!fsList || fsList.length === 0)
    return ctx.reply("Belum ada Flash Sale yang aktif saat ini.");

  const store = readDB(db_path.store);
  let t = "⚡ *DAFTAR FLASH SALE AKTIF*\n━━━━━━━━━━━━━━━━━━\n\n";
  let buttons = [];

  fsList.forEach((fs, idx) => {
    const p = store.products.find((x) => x.id === fs.productId);
    const pName = p ? p.name : "Produk Dihapus";
    let status = "Aktif";
    if (Date.now() > fs.expiresAt) status = "🔴 WAKTU HABIS";
    else {
      const sisa = Math.floor((fs.expiresAt - Date.now()) / 3600000);
      status = `🟢 Sisa ${sisa} Jam`;
    }
    if (fs.usedCount >= fs.maxUses) status = "🔴 KUOTA HABIS";

    t += `${idx + 1}. *${pName}*\n   📉 Diskon: ${fs.discount}\n   👥 Kuota: ${fs.usedCount}/${fs.maxUses}\n   ⏳ Status: ${status}\n\n`;
    buttons.push([
      Markup.button.callback(
        `🗑 Hapus FS ${pName.substring(0, 10)}`,
        `del_fs_${fs.productId}`,
      ),
    ]);
  });

  await ctx
    .editMessageText(t, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard(buttons),
    })
    .catch(() => { });
});

bot.action(/^del_fs_(.*)$/, async (ctx) => {
  if (String(ctx.from.id) !== OWNER_ID) return;
  const pId = ctx.match[1];
  let fsList = readDB(db_path.flashsale);
  const initialLen = fsList.length;
  fsList = fsList.filter((f) => String(f.productId) !== String(pId));

  if (fsList.length < initialLen) {
    writeDB(db_path.flashsale, fsList);
    await ctx.answerCbQuery(`✅ Flash Sale dihapus!`, true).catch(() => { });
    ctx.reply(`✅ Berhasil menghentikan Flash Sale untuk Produk ID *${pId}*.`, {
      parse_mode: "Markdown",
    });
    await ctx.deleteMessage().catch(() => { });
  } else {
    await ctx
      .answerCbQuery(`❌ Flash Sale tidak ditemukan!`, true)
      .catch(() => { });
  }
});

bot.action(/^admstck_c_(.*)$/, async (ctx) => {
  try {
    const catStrBase64 = ctx.match[1];
    const store = readDB(db_path.store);
    const activeCats = [
      ...new Set(store.products.map((p) => p.category).filter(Boolean)),
    ];
    const categoryExtracted = findC(catStrBase64, activeCats);
    const prods = store.products.filter(
      (p) => p.category === categoryExtracted,
    );

    if (prods.length === 0)
      return ctx.answerCbQuery("Kategori ini kosong.", true).catch(() => { });

    let buttons = [];
    prods.forEach((p) => {
      buttons.push([
        Markup.button.callback(`🏷 ${p.name}`, `admstck_p_${p.id}`),
      ]);
    });

    await ctx.editMessageText(
      `📦 *Produk dalam kategori ${categoryExtracted}:*\nPilih produk yang ingin diisi stoknya:`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard(buttons),
      },
    );
  } catch (e) {
    await ctx.answerCbQuery("Terjadi kesalahan.", true).catch(() => { });
  }
});

bot.action(/^admstck_p_(.*)$/, async (ctx) => {
  try {
    const pId = ctx.match[1];
    const store = readDB(db_path.store);
    const p = store.products.find((x) => x.id === pId);

    if (p) {
      userState.set(ctx.from.id, { step: "adm_stok_bulk", pId: p.id });
      await ctx.deleteMessage();
      await bot.telegram.sendMessage(
        ctx.from.id,
        `Isi stok *${p.name}*:\n\n- Format Akun: \`email|password|pin\`\n- Format Link: Langsung tempel link per baris\n\nKirimkan Data Stok Sekarang:`,
        {
          parse_mode: "Markdown",
          ...Markup.keyboard([["🔙 Menu Admin"]]).resize(),
        },
      );
    } else {
      await ctx.answerCbQuery("Produk tidak ditemukan.", true).catch(() => { });
    }
  } catch (e) {
    await ctx.answerCbQuery("Terjadi kesalahan.", true).catch(() => { });
  }
});

bot.action(/^rate_(.*)$/, async (ctx) => {
  try {
    const score = parseInt(ctx.match[1]);
    const userId = ctx.from.id;

    let settings = readDB(db_path.settings);
    if (!settings.ratings) settings.ratings = [];

    settings.ratings.push({ userId, score });
    writeDB(db_path.settings, settings);

    await ctx
      .editMessageText(
        "✅ Penilaian Berhasil, terimakasih telah meluangkan waktunya untuk memberikan penilaian 🥰.",
      )
      .catch(() => { });
    await ctx
      .answerCbQuery("Terimakasih atas penilaiannya!", false)
      .catch(() => { });
    await sendSuccessSticker(userId);
  } catch (e) {
    await ctx.answerCbQuery("Sudah dinilai.", true).catch(() => { });
  }
});

// === TAHAP 1: HANDLER KATEGORI (Ambil Stok, Hapus Produk, Kosongkan Stok) ===
const handleAdminCatSelect = async (ctx, prefixAction, titleLabel) => {
  try {
    const catStrBase64 = ctx.match[1];
    const store = readDB(db_path.store);
    const activeCats = [
      ...new Set(store.products.map((p) => p.category).filter(Boolean)),
    ];
    const categoryExtracted = findC(catStrBase64, activeCats);
    const prods = store.products.filter(
      (p) => p.category === categoryExtracted,
    );

    if (prods.length === 0)
      return ctx.answerCbQuery("Kategori ini kosong.", true).catch(() => { });

    let buttons = [];
    prods.forEach((p) => {
      buttons.push([
        Markup.button.callback(`🏷 ${p.name}`, `${prefixAction}${p.id}`),
      ]);
    });

    await ctx.editMessageText(
      `${titleLabel} dalam kategori *${categoryExtracted}*:`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard(buttons),
      },
    );
  } catch (e) {
    await ctx.answerCbQuery("Terjadi kesalahan.", true).catch(() => { });
  }
};

bot.action(/^d_get_c_(.*)$/, async (ctx) =>
  handleAdminCatSelect(
    ctx,
    "d_get_p_",
    "🔑 *Pilih Produk untuk Diambil Stoknya*",
  ),
);
bot.action(/^d_delp_c_(.*)$/, async (ctx) =>
  handleAdminCatSelect(
    ctx,
    "d_delp_p_",
    "🗑️ *Pilih Produk yang Ingin Dihapus*",
  ),
);
bot.action(/^d_dels_c_(.*)$/, async (ctx) =>
  handleAdminCatSelect(
    ctx,
    "d_dels_p_",
    "🧹 *Pilih Produk yang Stoknya Ingin Dikosongkan*",
  ),
);

// === TAHAP 2: HANDLER PRODUK (Eksekusi Aksi) ===

bot.action(/^d_get_p_(.*)$/, async (ctx) => {
  try {
    const pId = ctx.match[1];
    const store = readDB(db_path.store);
    const p = store.products.find((x) => x.id === pId);
    if (!p)
      return ctx
        .answerCbQuery("❌ Produk tidak ditemukan.", true)
        .catch(() => { });

    if (p.stocks.length === 0) {
      await ctx.answerCbQuery("Stok produk ini kosong.", true);
      return ctx.deleteMessage();
    }
    let txtInfo = `📦 *STOK PRODUK: ${p.name}*\nJumlah: ${p.stocks.length}\n━━━━━━━━━━━━━━━━━━\n\n`;
    p.stocks.forEach((s, i) => {
      const row =
        `${s.email || ""}|${s.pw || ""}|${s.pin || ""}|${s.link || ""}|${s.a2f || ""}|${s.profile || ""}`.replace(
          /\|+$/,
          "",
        );
      txtInfo += `${i + 1}. \`${row}\`\n`;
    });

    userState.set(ctx.from.id, { step: "adm_ambil_stok", pId: pId });
    await ctx.reply(
      txtInfo +
      "\n💡 *Balas dengan nomor urut* (contoh: `1`) untuk menghapus/mengambil stok tersebut.",
      {
        parse_mode: "Markdown",
        ...Markup.keyboard([["🔙 Menu Admin"]]).resize(),
      },
    );
    await ctx.deleteMessage().catch(() => { });
  } catch (e) {
    ctx.answerCbQuery("Error", true).catch(() => { });
  }
});

bot.action(/^d_delp_p_(.*)$/, async (ctx) => {
  try {
    const pId = ctx.match[1];
    let store = readDB(db_path.store);
    const pIdx = store.products.findIndex((x) => x.id === pId);
    if (pIdx === -1)
      return ctx
        .answerCbQuery("❌ Produk tidak ditemukan.", true)
        .catch(() => { });
    const pName = store.products[pIdx].name;

    store.products.splice(pIdx, 1);
    writeDB(db_path.store, store);

    let fsList = readDB(db_path.flashsale) || [];
    const initialLen = fsList.length;
    fsList = fsList.filter((f) => String(f.productId) !== String(pId));
    if (fsList.length < initialLen) writeDB(db_path.flashsale, fsList);

    await ctx.reply(
      `✅ *Produk ${pName}* (ID: ${pId}) berhasil dihapus beserta stoknya.`,
      { parse_mode: "Markdown" },
    );
    await ctx.deleteMessage().catch(() => { });
  } catch (e) {
    ctx.answerCbQuery("Error", true).catch(() => { });
  }
});

bot.action(/^d_dels_p_(.*)$/, async (ctx) => {
  try {
    const pId = ctx.match[1];
    let store = readDB(db_path.store);
    const pIdx = store.products.findIndex((x) => x.id === pId);
    if (pIdx === -1)
      return ctx
        .answerCbQuery("❌ Produk tidak ditemukan.", true)
        .catch(() => { });
    const pName = store.products[pIdx].name;

    store.products[pIdx].stocks = [];
    writeDB(db_path.store, store);
    await ctx.reply(`🧹 *Stok Produk ${pName}* berhasil dikosongkan.`, {
      parse_mode: "Markdown",
    });
    await ctx.deleteMessage().catch(() => { });
  } catch (e) {
    ctx.answerCbQuery("Error", true).catch(() => { });
  }
});

bot.action(/^fs_get_c_(.*)$/, async (ctx) => {
  try {
    const catStrBase64 = ctx.match[1];
    const catName = findC(catStrBase64, readDB(db_path.store).categories);
    const store = readDB(db_path.store);
    const prods = store.products.filter((p) => p.category === catName);

    if (prods.length === 0)
      return ctx.answerCbQuery("Kategori ini kosong.", true).catch(() => { });

    let buttons = [];
    prods.forEach((p) =>
      buttons.push([
        Markup.button.callback(`🏷 ${p.name}`, `fs_get_p_${p.id}`),
      ]),
    );

    await ctx.editMessageText(
      `📦 *Produk Kategori ${catName}:*\nPilih produk untuk di-Flash Sale:`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard(buttons),
      },
    );
  } catch (e) {
    await ctx.answerCbQuery("Terjadi kesalahan.", true).catch(() => { });
  }
});

bot.action(/^fs_get_p_(.*)$/, async (ctx) => {
  const pId = ctx.match[1];
  userState.set(ctx.from.id, { step: "adm_fs_config", pId: pId });
  await ctx.deleteMessage().catch(() => { });
  ctx.reply(
    "⚡ Masukkan konfigurasi Flash Sale:\nFormat: `DISKON|KUOTA_PEMBELI|JAM_AKTIF`\nContoh: `50%|10|2` (Diskon 50% untuk 10 pengguna pertama, aktif 2 jam)",
    {
      parse_mode: "Markdown",
      ...Markup.keyboard([["🔙 Menu Admin"]]).resize(),
    },
  );
});

bot.action("batal_belanja", async (ctx) => {
  try {
    await ctx.deleteMessage();
  } catch (e) { }
  const u = readDB(db_path.user);
  const user = u.find((x) => String(x.id) === String(ctx.from.id));
  if (user) {
    const { text, kb } = getStartMessage(
      ctx,
      user,
      u.length,
      readDB(db_path.trx),
    );
    try {
      await ctx.replyWithPhoto(
        { source: THUMBNAIL },
        { caption: text, parse_mode: "HTML", ...kb },
      );
    } catch (e) {
      await ctx.reply(text, { parse_mode: "HTML", ...kb });
    }
  }
  await sendCancelSticker(ctx.from.id);
});

bot.hears("/rekap", async (ctx) => {
  if (String(ctx.from.id) !== OWNER_ID) return;
  const txs = readDB(db_path.trx);
  const successTxs = txs.filter((t) => t.status === "success");
  if (successTxs.length === 0)
    return ctx.reply("Belum ada riwayat transaksi yang sukses.");

  let csvData = "Order ID;Tanggal;Produk;Qty;Harga Satuan;Total Bayar\n";
  successTxs.forEach((tx) => {
    const qty = tx.qty || 1;
    const total = tx.amount || 0;
    const satuan = total / qty;
    csvData += `"${tx.orderId}";"${tx.date}";"${tx.productName}";${qty};${satuan};${total}\n`;
  });

  const buffer = Buffer.from(csvData, "utf-8");
  await ctx.replyWithDocument(
    { source: buffer, filename: `Rekap_Keuangan_${Date.now()}.csv` },
    {
      caption: "📊 *Ini adalah Laporan Rekap Keuangan Anda.*",
      parse_mode: "Markdown",
    },
  );
});

bot.action(/^notify_restock_(.*)$/, async (ctx) => {
  const pId = ctx.match[1];
  let store = readDB(db_path.store);
  const pIdx = store.products.findIndex((x) => x.id === pId);
  if (pIdx === -1)
    return ctx.answerCbQuery("Produk tidak ditemukan.", true).catch(() => { });

  if (!store.products[pIdx].notifyList) store.products[pIdx].notifyList = [];
  if (!store.products[pIdx].notifyList.includes(ctx.from.id)) {
    store.products[pIdx].notifyList.push(ctx.from.id);
    writeDB(db_path.store, store);
    ctx
      .answerCbQuery(
        "✅ Mengantre! Anda akan dinotifikasi otomatis saat stok diisi nanti.",
        true,
      )
      .catch(() => { });
  } else {
    ctx
      .answerCbQuery("ℹ️ Ingat, Anda sudah masuk ke antrean notifikasi.", true)
      .catch(() => { });
  }
});

// === MESSAGE LISTENER ===
bot.on("message", async (ctx) => {
  if (!ctx.message || !ctx.from) return;
  const id = ctx.from.id;
  const txt = ctx.message.text || "";
  const st = userState.get(id);

  // 1. --- PRIORITAS: CEK AKHIRI CHAT ---
  if (txt.includes("🛑 AKHIRI CHAT")) {
    if (activeChats.has(id)) {
      const target = activeChats.get(id);
      activeChats.delete(id);
      activeChats.delete(target);

      await bot.telegram.sendMessage(
        id,
        "Sesi bantuan telah diakhiri.\nKetik /start untuk membuka menu utama.",
        Markup.removeKeyboard(),
      );
      await bot.telegram.sendMessage(
        target,
        "🛑 Sesi bantuan telah diakhiri oleh lawan bicara.\nKetik /start untuk membuka menu utama.",
        String(target) === OWNER_ID ? kbAdmin : Markup.removeKeyboard(),
      );
      return;
    } else if (st && st.step === "ask_support") {
      userState.delete(id);
      await ctx.reply(
        "Permintaan bantuan dibatalkan.",
        Markup.removeKeyboard(),
      );
      const u = readDB(db_path.user);
      const user = u.find((x) => String(x.id) === String(id));
      if (user) {
        const { text, kb } = getStartMessage(
          ctx,
          user,
          u.length,
          readDB(db_path.trx),
        );
        try {
          await ctx.replyWithPhoto(
            { source: THUMBNAIL },
            { caption: text, parse_mode: "HTML", ...kb },
          );
        } catch (e) {
          await ctx.reply(text, { parse_mode: "HTML", ...kb });
        }
      }
      return;
    }
  }

  // 2. --- PRIORITAS: ADMIN QUICK REPLY (BALAS PESAN TERTENTU) ---
  if (String(id) === OWNER_ID && ctx.message.reply_to_message) {
    const replyMsg = ctx.message.reply_to_message;
    const targetMatch = (replyMsg.text || replyMsg.caption || "").match(
      /🆔 ID: `(\d+)`/,
    );
    if (targetMatch) {
      const targetUserId = targetMatch[1];
      try {
        if (txt) {
          await bot.telegram.sendMessage(
            targetUserId,
            `💬 *BALASAN ADMIN:*\n\n${txt}`,
            { parse_mode: "Markdown" },
          );
        } else {
          await bot.telegram.copyMessage(
            targetUserId,
            id,
            ctx.message.message_id,
          );
          await bot.telegram.sendMessage(
            targetUserId,
            `💬 *BALASAN ADMIN (MEDIA)*`,
            { parse_mode: "Markdown" },
          );
        }
        return ctx.reply(`✅ Balasan terkirim ke user \`${targetUserId}\`.`, {
          parse_mode: "Markdown",
        });
      } catch (e) {
        return ctx.reply(
          "❌ Gagal mengirim balasan. User mungkin memblokir bot.",
        );
      }
    }
  }

  // 3. --- LIVE CHAT MIRRORING ---
  if (activeChats.has(id)) {
    const target = activeChats.get(id);
    return bot.telegram.copyMessage(target, id, ctx.message.message_id);
  }

  // 4. --- PENGAJUAN LIVE CHAT (User Side) ---
  if (st && st.step === "ask_support") {
    if (txt === "🔙 Menu Utama") {
      userState.delete(id);
      await ctx.reply("Memuat Menu Utama...", Markup.removeKeyboard());
      const u = readDB(db_path.user);
      const user = u.find((x) => String(x.id) === String(id));
      if (user) {
        const { text, kb } = getStartMessage(
          ctx,
          user,
          u.length,
          readDB(db_path.trx),
        );
        try {
          await ctx.replyWithPhoto(
            { source: THUMBNAIL },
            { caption: text, parse_mode: "HTML", ...kb },
          );
        } catch (e) {
          await ctx.reply(text, { parse_mode: "HTML", ...kb });
        }
      }
      return;
    }
    const safeNameAdmin = sanitizeMD(ctx.from.first_name || "User");
    const safeMsgTxt = txt ? sanitizeMD(txt) : "[Media]";
    await bot.telegram.sendMessage(
      OWNER_ID,
      `💬 *PESAN BANTUAN BARU*\n━━━━━━━━━━━━━━━━━━\n👤 User: ${safeNameAdmin}\n🆔 ID: \`${id}\`\n💬 Pesan: ${safeMsgTxt}\n━━━━━━━━━━━━━━━━━━\n\n_Tips: Balas (reply) pesan ini untuk membalas user secara instan._`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("✅ Balas Chat (Live)", `accept_chat_${id}`)],
        ]),
      },
    );
    if (!txt)
      await bot.telegram.copyMessage(OWNER_ID, id, ctx.message.message_id);
    return ctx.reply(
      "✅ Pesan diteruskan. Admin akan segera membalas di sini. Anda bisa mengirim pesan tambahan jika perlu.",
    );
  }

  // 5. --- ADMIN STICKER SETTINGS ---
  if (st && st.step === "adm_set_sticker_success" && ctx.message.sticker) {
    let settings = readDB(db_path.settings);
    settings.success_sticker = ctx.message.sticker.file_id;
    writeDB(db_path.settings, settings);
    userState.delete(id);
    return ctx.reply("✅ Stiker sukses diperbarui!", kbAdmin);
  }
  if (st && st.step === "adm_set_sticker_cancel" && ctx.message.sticker) {
    let settings = readDB(db_path.settings);
    settings.cancel_sticker = ctx.message.sticker.file_id;
    writeDB(db_path.settings, settings);
    userState.delete(id);
    return ctx.reply("✅ Stiker batal diperbarui!", kbAdmin);
  }

  if (!st) return;

  // --- LOGIKA MENU LAINNYA ---
  if (st.step === "input_voucher" && txt) {
    const code = txt.trim().toUpperCase();
    let promos = readDB(db_path.promo);
    const voucher = promos.find((p) => p.code === code);

    if (!voucher) {
      userState.set(id, { ...st, step: "" });
      return ctx.reply(
        "❌ Kode voucher tidak ditemukan. Silakan klik 'Refresh' pada menu sebelumnya.",
      );
    }

    if (voucher.expiresAt && Date.now() > voucher.expiresAt) {
      userState.set(id, { ...st, step: "" });
      return ctx.reply("❌ Voucher ini sudah kedaluwarsa (Expired).");
    }

    if (voucher.usedBy && voucher.usedBy.includes(id)) {
      userState.set(id, { ...st, step: "" });
      return ctx.reply("❌ Voucher ini sudah Anda gunakan sebelumnya.");
    }

    // Simpan voucher ke dalam statenya sementara, belum dipakai sungguhan
    const newState = { ...st, step: "", activeVoucher: voucher };
    userState.set(id, newState);

    return ctx.reply(
      `🎉 *Voucher ${voucher.code} Berhasil Diterapkan!*\nSilakan klik tombol 🔄 *Refresh* pada pesan detail produk di atas untuk melihat harga baru.`,
      { parse_mode: "Markdown" },
    );
  }

  if (st.step === "cat" && /^\d+$/.test(txt)) {
    const s = readDB(db_path.store);
    const cats = [...new Set(s.categories)].sort();
    const catName = cats[parseInt(txt) - 1];

    if (catName) {
      const prods = s.products.filter((p) => p.category === catName);
      if (prods.length === 0) return ctx.reply("Kategori kosong.");

      userState.set(id, { step: "prod_select", prods: prods });
      let listText = `📁 KATEGORI: *${catName.toUpperCase()}*\n━━━━━━━━━━━━━━━━━━\n\n`;
      let row = [];
      let rows = [];

      prods.forEach((p, i) => {
        listText += `${i + 1}. *${p.name}*\n💰 Harga: Rp ${p.price.toLocaleString()}\n📦 Stok: *${p.stocks.length}*\n\n`;
        row.push(`${i + 1}`);
        if (row.length === 5) {
          rows.push(row);
          row = [];
        }
      });

      if (row.length > 0) rows.push(row);
      rows.push(["🔙 Menu Utama"]);

      try {
        await ctx.replyWithPhoto(
          { source: THUMBNAIL },
          {
            caption: listText,
            parse_mode: "Markdown",
            ...Markup.keyboard(rows).resize(),
          },
        );
      } catch (e) {
        await ctx.reply(listText, {
          parse_mode: "Markdown",
          ...Markup.keyboard(rows).resize(),
        });
      }
    }
    return;
  }

  if (st.step === "prod_select" && /^\d+$/.test(txt)) {
    const idx = parseInt(txt) - 1;
    if (st.prods && st.prods[idx]) {
      const p = st.prods[idx];
      userState.delete(id);
      const detail = `📦 *${p.name.toUpperCase()}*\n━━━━━━━━━━━━━━━━━━\n💰 Harga: *Rp ${p.price.toLocaleString()}*\n📦 Stok: *${p.stocks.length}*\n\n📝 Deskripsi:\n${p.desc || "-"}\n━━━━━━━━━━━━━━━━━━`;
      const b = [];
      if (p.stocks.length === 0) {
        b.push([
          Markup.button.callback(
            "📢 Kabari Saya saat Restock",
            `notify_restock_${p.id}`,
          ),
        ]);
      } else {
        b.push([
          Markup.button.callback("1x", `qset_${p.id}_1`),
          Markup.button.callback("5x", `qset_${p.id}_5`),
        ]);
        b.push([Markup.button.callback("10x", `qset_${p.id}_10`)]);
      }
      b.push([Markup.button.callback("🔙 Kembali", "batal_belanja")]);

      try {
        await ctx.replyWithPhoto(
          { source: THUMBNAIL },
          {
            caption: detail,
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard(b),
          },
        );
      } catch (e) {
        await ctx.reply(detail, {
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard(b),
        });
      }
    }
    return;
  }

  // --- LOGIKA KHUSUS OWNER/ADMIN ---
  if (String(id) === OWNER_ID) {
    let s = readDB(db_path.store);

    // Pengelolaan Saldo
    if (st.step === "adm_saldo") {
      const parts = txt.split(" ");
      const action = parts[0]?.toLowerCase();
      const targetId = parts[1];
      const amount = parseInt(parts[2]);

      if (parts.length < 3 || isNaN(amount))
        return ctx.reply("❌ Format: `add/sub [ID] [NOMINAL]`");

      let users = readDB(db_path.user);
      const uIdx = users.findIndex((u) => String(u.id) === String(targetId));

      if (uIdx === -1) return ctx.reply("❌ User tidak ada!");

      if (action === "add") {
        users[uIdx].balance += amount;
        ctx.reply(`✅ +Rp ${amount.toLocaleString()} ke ${targetId}`, kbAdmin);
        bot.telegram.sendMessage(
          targetId,
          `💰 *SALDO DITAMBAHKAN*\nTotal: *Rp ${users[uIdx].balance.toLocaleString()}*`,
          { parse_mode: "Markdown" },
        );
      } else if (action === "sub") {
        users[uIdx].balance -= amount;
        ctx.reply(
          `✅ -Rp ${amount.toLocaleString()} dari ${targetId}`,
          kbAdmin,
        );
        bot.telegram.sendMessage(
          targetId,
          `💰 *SALDO DIKURANGI*\nTotal: *Rp ${users[uIdx].balance.toLocaleString()}*`,
          { parse_mode: "Markdown" },
        );
      }
      writeDB(db_path.user, users);
      return userState.delete(id);
    }

    // Tambah Kategori
    if (st.step === "adm_cat") {
      const parts = txt.split("|");
      const catName = parts[0].trim().toUpperCase();
      const catDesc = parts.slice(1).join("|").trim() || "-";

      if (!s.category_details) s.category_details = {};
      if (!s.categories.includes(catName)) {
        s.categories.push(catName);
      }
      s.category_details[catName] = catDesc;
      writeDB(db_path.store, s);
      ctx.reply("✅ Kategori Ditambah.", kbAdmin);
      return userState.delete(id);
    }

    // Tambah Promo Voucher (Dengan Waktu)
    if (st.step === "adm_promo") {
      const parts = txt.trim().split("|");
      if (parts.length < 3)
        return ctx.reply(
          "❌ Format salah! Harap gunakan format: KODE|DISKON|JAM_AKTIF\nContoh: DISKON50|50%|24 atau HEMAT10|10000|72",
        );

      const code = parts[0].trim().toUpperCase();
      const discount = parts[1].trim().replace(/[^\d%]/g, "");
      const hours = parseInt(parts[2].trim());

      if (isNaN(hours)) return ctx.reply("❌ Jumlah Jam harus berupa angka.");

      const expiresAt = Date.now() + hours * 3600000; // 1 jam = 3600000 ms

      let promos = readDB(db_path.promo);
      if (!promos || !Array.isArray(promos)) promos = [];
      promos.push({
        code: code,
        discount: discount,
        expiresAt: expiresAt,
        usedBy: [],
      });
      writeDB(db_path.promo, promos);

      try {
        if (global.CHANNEL) {
          let chUsername = global.CHANNEL.includes("t.me/")
            ? "@" + global.CHANNEL.split("t.me/")[1].split("/")[0]
            : global.CHANNEL;
          if (chUsername) {
            const botName = ctx.botInfo ? ctx.botInfo.username : "";
            const botLink = botName ? `\n\nCek langsung di @${botName}` : "";
            const chMsg = `🎟 *VOUCHER & PROMO BARU* 🎟\n━━━━━━━━━━━━━━━━━━\n\nKabar gembira! Ada voucher promosi yang baru saja dirilis!\n\n🔖 Kode Voucher: \`${code}\`\n📉 Diskon: *${discount}*\n⏳ Berlaku: *${hours} Jam*\n\nBuruan gunakan pada saat pemesanan sebelum expired! 🚀${botLink}`;
            bot.telegram
              .sendMessage(chUsername, chMsg, { parse_mode: "Markdown" })
              .catch(() => { });
          }
        }
      } catch (e) {
        console.log("Gagal broadcast voucher", e);
      }

      ctx.reply(
        `✅ Promo Voucher \`${code}\` berhasil ditambahkan!\nDiskon: ${discount}\nAktif selama: ${hours} Jam`,
        { parse_mode: "Markdown", ...kbAdmin },
      );
      return userState.delete(id);
    }

    // Tambah Konfigurasi Flash Sale
    if (st.step === "adm_fs_config") {
      const parts = txt.trim().split("|");
      if (parts.length < 3)
        return ctx.reply(
          "❌ Format salah! Harap gunakan format: DISKON|KUOTA_PEMBELI|JAM_AKTIF\nContoh: 50%|10|2 atau 10000|5|24",
        );

      const discount = parts[0].trim().replace(/[^\d%]/g, "");
      const maxUses = parseInt(parts[1].trim());
      const hours = parseInt(parts[2].trim());

      if (isNaN(maxUses) || isNaN(hours))
        return ctx.reply("❌ Kuota dan Jam Aktif harus berupa angka.");

      const expiresAt = Date.now() + hours * 3600000;

      let fsList = readDB(db_path.flashsale);
      if (!fsList || !Array.isArray(fsList)) fsList = [];
      fsList.push({
        productId: st.pId,
        discount: discount,
        maxUses: maxUses,
        usedCount: 0,
        expiresAt: expiresAt,
      });
      writeDB(db_path.flashsale, fsList);

      try {
        if (global.CHANNEL) {
          let chUsername = global.CHANNEL.includes("t.me/")
            ? "@" + global.CHANNEL.split("t.me/")[1].split("/")[0]
            : global.CHANNEL;
          if (chUsername) {
            const pIdx = s.products.findIndex((x) => x.id === st.pId);
            const pName =
              pIdx !== -1 ? s.products[pIdx].name : "Produk Spesial";
            const botName = ctx.botInfo ? ctx.botInfo.username : "";
            const botLink = botName ? `\n\nCek langsung di @${botName}` : "";
            const chMsg = `⚡ *FLASH SALE DIMULAI* ⚡\n━━━━━━━━━━━━━━━━━━\n\nProduk: *${pName}*\n\n🔥 Diskon: *${discount}*\n👥 Kuota Dibatasi: *Hanya untuk ${maxUses} pembeli!*\n⏳ Waktu: *Terbatas ${hours} Jam saja!*\n\nJangan sampai kehabisan, buruan cek Flash Sale nya sekarang! 🚀${botLink}`;
            bot.telegram
              .sendMessage(chUsername, chMsg, { parse_mode: "Markdown" })
              .catch(() => { });
          }
        }
      } catch (e) {
        console.log("Gagal broadcast flash sale", e);
      }

      ctx.reply(
        `⚡ *Flash Sale Berhasil Diaktifkan!*\nProduk ID: \`${st.pId}\`\nDiskon: ${discount}\nKuota: ${maxUses} Pembeli\nAktif: ${hours} Jam`,
        { parse_mode: "Markdown", ...kbAdmin },
      );
      return userState.delete(id);
    }

    // Tambah Produk
    if (st.step === "adm_prod") {
      // Format input: Kategori|Nama|Harga|Deskripsi|Pesan_Sukses|HargaGrosir|MinBeliGrosir
      const [c, n, pr, d, sm, gp, gm] = txt.split("|");
      if (!c || !n || !pr)
        return ctx.reply(
          "❌ Format: Kategori|Nama|Harga|Deskripsi|Pesan_Sukses (Grosir opsional)",
        );

      s.products.push({
        id: `P${Date.now()}`,
        category: c.trim(),
        name: n.trim(),
        price: parseInt(pr),
        desc: d || "",
        success_msg: sm || "",
        grosir_price: parseInt(gp) || null,
        grosir_min: parseInt(gm) || null,
        stocks: [],
      });
      writeDB(db_path.store, s);
      ctx.reply(`✅ Produk ${n} berhasil ditambah!`, kbAdmin);
      return userState.delete(id);
    }

    // --- FIX: INPUT STOK (KONSOLIDASI) ---
    if (st.step === "adm_stok_bulk") {
      const pIdx = s.products.findIndex((x) => x.id === st.pId);
      if (pIdx === -1) return ctx.reply("❌ Produk hilang dari database!");

      const lines = txt.split("\n").filter((l) => l.trim().length > 0);

      lines.forEach((l) => {
        const pData = l.split("|");
        s.products[pIdx].stocks.push({
          email: pData[0] || l,
          pw: pData[1] || "",
          pin: pData[2] || "",
          a2f: pData[3] || "",
          profile: pData[4] || "",
          isLink: !pData[1], // Jika tidak ada password, dianggap link/teks biasa
        });
      });

      // Handle Notifikasi Restock
      if (
        s.products[pIdx].notifyList &&
        s.products[pIdx].notifyList.length > 0
      ) {
        const list = s.products[pIdx].notifyList;
        const pName = s.products[pIdx].name;
        const botName = ctx.botInfo ? ctx.botInfo.username : "";
        s.products[pIdx].notifyList = []; // Reset antrean
        writeDB(db_path.store, s);

        ctx.reply(
          `✅ Berhasil menambahkan ${lines.length} stok.\n📢 Mengirim pesan notifikasi ke *${list.length}* calon pembeli...`,
          { parse_mode: "Markdown", ...kbAdmin },
        );
        list.forEach((userId) => {
          const msg = `📢 *RESTOCK ALERT!* 📢\n━━━━━━━━━━━━━━━━━━\n\nProduk incaran Anda yaitu *${pName}* kini telah KEMBALI TERSEDIA dengan stok baru!\n\nBuruan order via @${botName} sebelum kehabisan lagi ya! 🚀`;
          bot.telegram
            .sendMessage(userId, msg, { parse_mode: "Markdown" })
            .catch(() => { });
        });
      } else {
        writeDB(db_path.store, s);
        ctx.reply(`✅ Berhasil menambahkan ${lines.length} stok.`, kbAdmin);
      }
      return userState.delete(id);
    }

    // --- FIX: AMBIL STOK (HAPUS 1 PER MINTAAN) ---
    if (st.step === "adm_ambil_stok") {
      const pIdx = s.products.findIndex((x) => x.id === st.pId);
      if (pIdx === -1) return ctx.reply("❌ Produk hilang dari database!");

      const stockIdx = parseInt(txt) - 1;
      if (
        isNaN(stockIdx) ||
        stockIdx < 0 ||
        stockIdx >= s.products[pIdx].stocks.length
      ) {
        return ctx.reply("❌ Masukkan nomor urut yang valid!");
      }

      const removed = s.products[pIdx].stocks.splice(stockIdx, 1)[0];
      writeDB(db_path.store, s);

      const row =
        `${removed.email || ""}|${removed.pw || ""}|${removed.pin || ""}|${removed.link || ""}|${removed.a2f || ""}|${removed.profile || ""}`.replace(
          /\|+$/,
          "",
        );
      ctx.reply(`✅ Stok berhasil dihapus/diambil:\n\`${row}\``, {
        parse_mode: "Markdown",
        ...kbAdmin,
      });
      return userState.delete(id);
    }

    if (st.step === "adm_bc") {
      const users = readDB(db_path.user);
      let successCount = 0;
      ctx.reply(`🚀 Broadcasting...`);
      for (let u of users) {
        try {
          await bot.telegram.copyMessage(u.id, id, ctx.message.message_id);
          successCount++;
        } catch (e) { }
      }
      ctx.reply(`✅ Selesai: *${successCount}* user.`, {
        parse_mode: "Markdown",
        ...kbAdmin,
      });
      return userState.delete(id);
    }

    // --- PROSES HAPUS DATA ---
    if (st.step === "adm_del_cat") {
      const catName = txt.trim();
      const idx = s.categories.indexOf(catName);
      if (idx !== -1) {
        s.categories.splice(idx, 1);
        if (s.category_details) delete s.category_details[catName];
        writeDB(db_path.store, s);
        ctx.reply(`✅ Kategori \`${catName}\` berhasil dihapus.`, {
          parse_mode: "Markdown",
          ...kbDeleteMenu,
        });
      } else
        ctx.reply("❌ Kategori tidak ditemukan. Pastikan nama sama persis.");
      return userState.delete(id);
    }

    // --- PROSES EDIT DATA ---
    if (st.step === "adm_edit_cat") {
      const parts = txt.split("|");
      if (parts.length < 2)
        return ctx.reply("❌ Format Salah. Harus: NamaBaru|DeskripsiBaru");
      const newName = parts[0].trim().toUpperCase();
      const newDesc = parts.slice(1).join("|").trim();

      const oldName = st.catName;
      const idx = s.categories.indexOf(oldName);
      if (idx !== -1) {
        s.categories[idx] = newName;
        if (!s.category_details) s.category_details = {};
        s.category_details[newName] = newDesc;
        if (newName !== oldName) {
          delete s.category_details[oldName];
          s.products.forEach((p) => {
            if (p.category === oldName) p.category = newName;
          });
        }
        writeDB(db_path.store, s);
        ctx.reply(
          `✅ Kategori ${oldName} berhasil diubah menjadi ${newName}.`,
          kbAdmin,
        );
      } else {
        ctx.reply("❌ Kategori tidak ditemukan.", kbAdmin);
      }
      return userState.delete(id);
    }

    if (st.step === "adm_edit_prod") {
      const parts = txt.split("|");
      if (parts.length < 5)
        return ctx.reply(
          "❌ Format input minimum memiliki 5 bagian yang dipisah '|'.",
        );

      const pIdx = s.products.findIndex((x) => x.id === st.pId);
      if (pIdx === -1) return ctx.reply("❌ Produk tidak ditemukan.");

      s.products[pIdx].category = parts[0].trim().toUpperCase();
      s.products[pIdx].name = parts[1].trim();
      s.products[pIdx].price = parseInt(parts[2]);
      s.products[pIdx].desc = parts[3].trim();
      s.products[pIdx].success_msg = parts[4].trim();
      if (parts[5] !== undefined && parts[6] !== undefined) {
        s.products[pIdx].grosir_price = parseInt(parts[5]) || null;
        s.products[pIdx].grosir_min = parseInt(parts[6]) || null;
      }

      writeDB(db_path.store, s);
      ctx.reply(`✅ Produk berhasil diedit!`, kbAdmin);
      return userState.delete(id);
    }
  }
});

// Start loop
bot.catch((err, ctx) => {
  const errorMsg = err.description || err.message || "";

  // TAMBAHKAN BARIS INI: Filter error blokir user agar terminal tetap bersih
  if (errorMsg.includes("Forbidden: bot was blocked by the user")) {
    return; // Hentikan proses, jangan print log error
  }

  log.error(`Terjadi error pada update ${ctx.updateType}`, err);
});
async function start() {
  console.clear();
  console.log(
    chalk.blue(figlet.textSync("BOT LAGI GAWE", { font: "Standard" })),
  );
  setInterval(paymentLoop, 30000);
  bot
    .launch()
    .then(() => log.success(`Bot Running as ${bot.botInfo?.username}`))
    .catch((e) => log.error("Bot launch failed", e));
}

start();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
