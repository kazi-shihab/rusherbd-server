const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const db = require("../db");

const router = express.Router();

// Admin Login
router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: "Username and password required",
      });
    }

    const [admins] = await db.execute(
      `SELECT id, username, password
       FROM admins
       WHERE username = ?
       LIMIT 1`,
      [username],
    );

    if (!admins.length) {
      return res.status(401).json({
        success: false,
        message: "Invalid username or password",
      });
    }

    const admin = admins[0];

    const isPasswordValid = await bcrypt.compare(password, admin.password);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: "Invalid username or password",
      });
    }

    if (!process.env.JWT_SECRET) {
      throw new Error("JWT_SECRET is missing");
    }

    const token = jwt.sign(
      {
        adminId: admin.id,
        tokenType: "admin",
      },
      process.env.JWT_SECRET,
      { expiresIn: "30d" },
    );

    return res.json({
      success: true,
      message: "Admin login successful",
      token,
      admin: {
        id: admin.id,
        username: admin.username,
      },
    });
  } catch (error) {
    console.error("Admin Login Error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

module.exports = router;
