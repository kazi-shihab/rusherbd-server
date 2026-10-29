require("dotenv").config();

const mysql = require("mysql2/promise");
const fs = require("fs");
const path = require("path");

const db = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,

  // Aiven SSL Configuration
  ssl: {
    ca: fs.readFileSync(path.join(__dirname, "ca.pem")),
    rejectUnauthorized: true,
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
