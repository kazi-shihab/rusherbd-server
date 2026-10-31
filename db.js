require("dotenv").config();

const mysql = require("mysql2/promise");

const db = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,

  // Clever Cloud-এর জন্য এই SSL কনফিগারেশনটি ব্যবহার করুন
  ssl: {
    rejectUnauthorized: false, // এটি সেলফ-সাইনড সার্টিফিকেটের ইররটি সমাধান করবে
  },

  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

async function checkDatabase() {
  try {
    const [rows] = await db.query("SELECT 1 AS result");
    console.log("Database connected successfully", rows);
  } catch (err) {
    console.log("Database connection failed");
    console.log("Error code:", err.code);
    console.log("Error message:", err.message);
  }
}

checkDatabase();

module.exports = db;

