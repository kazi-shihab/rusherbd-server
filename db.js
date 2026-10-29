require("dotenv").config();

const mysql = require("mysql2/promise");

const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

async function checkDatabase() {
  try {
    await db.query("SELECT 1");
    console.log("Database connected successfully");
  } catch (err) {
    console.log("Database connection failed");
    console.log(err.message);
  }
}

checkDatabase();

module.exports = db;
