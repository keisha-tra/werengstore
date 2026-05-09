/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║        ⚙️  MOVA BOT — FILE KONFIGURASI UTAMA  ⚙️        ║
 * ║    Edit file ini untuk menyesuaikan bot dengan kebutuhan ║
 * ║               MOVA - All Rights Reserved                 ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 *  📌 PANDUAN SINGKAT:
 *  ─────────────────────────────────────────────────────────
 *  1. Isi setiap kolom yang bertanda  ← WAJIB DIISI
 *  2. Jangan hapus tanda kutip  " "  di sekitar nilai
 *  ─────────────────────────────────────────────────────────
 */

"use strict";

const fs = require("fs");
const chalk = require("chalk");
const moment = require("moment-timezone");
const figlet = require("figlet");

// ════════════════════════════════════════════════════════════
//  🤖  IDENTITAS BOT
//  Informasi dasar tentang bot kamu
// ════════════════════════════════════════════════════════════

global.BOT_NAME = "FalsePromise | BOT AUTO ORDER";  // ← Nama bot (tampil di semua notifikasi)
global.BOT_TOKEN = "8672643654:AAE3Bosa24GBVYugrH4OGnK6PbvfWkADG7k"; // ← Token dari @BotFather
global.urlBot = "t.me/thefalsepromisebot"; // ← Link username bot kamu
global.DEBUG = false; // Ubah ke  true  untuk melihat log detail (mode developer)

// ════════════════════════════════════════════════════════════
//  👤  DATA OWNER / ADMIN
//  Akun Telegram yang memiliki akses penuh ke bot
// ════════════════════════════════════════════════════════════

global.OWNER_NAME = "False promise";          // ← Nama owner Baru
global.OWNER_ID = "8379278966";              // ← ID Telegram kamu (cek di @userinfobot)
global.OWNER_NUMBER = "628";           // ← Nomor HP (format: 628xxx tanpa +)
global.OWNER = ["https://t.me/Palu99ada"]; // ← Username Telegram owner
global.CHANNEL = "https://t.me/Palu99ada";   // ← Link channel / grup utama

// ════════════════════════════════════════════════════════════
//  💳  PAKASIR — PAYMENT GATEWAY
//  Daftar akun & buat API Key di: https://pakasir.com/
// ════════════════════════════════════════════════════════════

global.PAKASIR_API_KEY = "8rj3ITG2NFFdu60CmYEdMCYTTzhlSpDA02"; // ← API Key Pakasir, Daftar Kyc dulu, trus Buat Project
global.PAKASIR_PROJECT_SLUG = "MOVA"; // ← Nama project (pastikan mode diatur ke "Action")

// ════════════════════════════════════════════════════════════
//  🖼️  GAMBAR & MEDIA
//  Lokasi file gambar yang digunakan bot
// ════════════════════════════════════════════════════════════

global.thumbnail = "./options/image/thumbnail.jpg"; // ← Ganti file di folder /options/image/

// ════════════════════════════════════════════════════════════
//  💬  PESAN SISTEM — NOTIFIKASI KE PENGGUNA
//  Kustomisasi teks yang dikirim bot kepada pengguna
// ════════════════════════════════════════════════════════════

global.mess = {

  // ✅ Respon sukses
  sukses: "✅ *Berhasil!* Pesananmu sedang diproses ya~ 🎉",

  // ⏳ Loading / proses
  wait: "⏳ *Mohon tunggu sebentar...*\nSedang memproses permintaanmu 🔄",

  // 🔒 Pembatasan akses
  admin: "🚫 *Ups!* Command ini hanya bisa digunakan oleh *Admin Grup*.",
  botAdmin: "⚠️ *Bot belum jadi Admin!*\nMinta admin grup untuk mengangkat bot sebagai admin dulu ya.",
  owner: "🔒 *Akses Ditolak!*\nCommand ini khusus untuk *Owner Bot* saja.",
  prem: "💎 *Fitur Premium!*\nUpgrade ke member premium untuk menggunakan fitur ini.\nHubungi admin: " + "https://t.me/jarcww",
  group: "👥 *Command Grup!*\nFitur ini hanya bisa digunakan di dalam *Grup*.",
  private: "🔐 *Private Only!*\nGunakan command ini lewat *chat pribadi* dengan bot ya.",

  // ❌ Error
  error: {
    lv: "❌ *Link tidak valid!*\nPastikan link yang kamu kirim sudah benar dan coba lagi.",
    api: "⚠️ *Terjadi Gangguan!*\nServer sedang sibuk. Mohon coba lagi dalam beberapa saat 🙏",
  },
};

// ════════════════════════════════════════════════════════════
//  🔍  VALIDASI KONFIGURASI
//  Memastikan semua setting penting sudah terisi dengan benar
// ════════════════════════════════════════════════════════════

function validateConfig() {
  const required = [
    { key: "BOT_TOKEN", label: "Token Bot", val: global.BOT_TOKEN },
    { key: "BOT_NAME", label: "Nama Bot", val: global.BOT_NAME },
    { key: "OWNER_ID", label: "ID Owner", val: global.OWNER_ID },
    { key: "PAKASIR_API_KEY", label: "API Key Pakasir", val: global.PAKASIR_API_KEY },
    { key: "PAKASIR_PROJECT_SLUG", label: "Project Pakasir", val: global.PAKASIR_PROJECT_SLUG },
  ];

  const placeholders = ["ISI_", "GANTI_", "YOUR_", "TOKEN_KAMU"];
  const errors = [];

  for (const field of required) {
    if (!field.val || field.val.trim() === "") {
      errors.push(`  ✗  ${field.label} (${field.key}) belum diisi!`);
    } else if (placeholders.some(p => field.val.includes(p))) {
      errors.push(`  ✗  ${field.label} (${field.key}) masih menggunakan nilai contoh!`);
    }
  }

  return errors;
}

// ════════════════════════════════════════════════════════════
//  🖥️  TAMPILAN STARTUP — BANNER & RINGKASAN KONFIGURASI
// ════════════════════════════════════════════════════════════

function printBanner() {
  const now = moment().tz("Asia/Jakarta").format("HH:mm:ss • DD MMMM YYYY");
  const width = 58;
  const line = "─".repeat(width);
  const dline = "═".repeat(width);

  const center = (text, pad = width) => {
    const visible = text.replace(/\x1b\[[0-9;]*m/g, ""); // strip ANSI for length calc
    const spaces = Math.max(0, Math.floor((pad - visible.length) / 2));
    return " ".repeat(spaces) + text;
  };

  console.log("\n" + chalk.cyan(dline));

  try {
    const bName = global.BOT_NAME ? global.BOT_NAME.split('|')[0].trim() : "STORE";
    const asciiArt = figlet.textSync(bName, { font: 'Standard' });
    console.log(chalk.cyan(asciiArt));
  } catch (err) {
    console.log(center(chalk.bold.cyan(global.BOT_NAME || "BOT")));
  }

  console.log(center(chalk.gray("B O T   A U T O   O R D E R")));
  console.log(chalk.cyan(dline));

  // Info baris
  const row = (icon, label, value) =>
    ` ${chalk.cyan(icon)}  ${chalk.gray(label.padEnd(20))} ${chalk.white(value)}`;

  console.log(row("🤖", "Bot Name", global.BOT_NAME));
  console.log(row("👤", "Owner", global.OWNER_NAME));
  console.log(row("📱", "Kontak", "+" + global.OWNER_NUMBER));
  console.log(row("🔗", "Link Bot", global.urlBot));
  console.log(row("📢", "Channel", global.CHANNEL));
  console.log(row("🕐", "Waktu Start", now));
  console.log(row("🛠️ ", "Debug Mode", global.DEBUG ? chalk.yellow("AKTIF") : chalk.green("Nonaktif")));

  // Validasi
  const errors = validateConfig();
  console.log("\n" + chalk.cyan(line));

  if (errors.length > 0) {
    console.log(chalk.bold.red(" ⚠️  PERINGATAN KONFIGURASI:"));
    errors.forEach(e => console.log(chalk.yellow(e)));
    console.log(chalk.red("\n  Bot mungkin tidak berfungsi dengan benar."));
    console.log(chalk.red("  Perbaiki nilai di atas pada file setting.js\n"));
  } else {
    console.log(chalk.bold.green(" ✅  Semua konfigurasi valid — Bot siap digunakan!"));
  }

  console.log(chalk.cyan(dline) + "\n");
}

// Jalankan banner saat pertama kali load
printBanner();

// ════════════════════════════════════════════════════════════
//  🔄  AUTO-RELOAD — Otomatis reload saat file disimpan
//  Kamu tidak perlu restart bot setiap kali ubah setting!
// ════════════════════════════════════════════════════════════

const _file = require.resolve(__filename);

fs.watchFile(_file, () => {
  fs.unwatchFile(_file);
  const time = moment().tz("Asia/Jakarta").format("HH:mm:ss");
  console.log(
    "\n" +
    chalk.bgCyan.bold.black("  SETTING DIPERBARUI  ") + "  " +
    chalk.gray(time) + "  " +
    chalk.cyanBright("⟳ setting.js dimuat ulang otomatis\n")
  );
  delete require.cache[_file];
  require(_file);
});
