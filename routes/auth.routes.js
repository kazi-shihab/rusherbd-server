const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const db = require("../db");

const router = express.Router();

router.post("/register", async (req, res) => {
  try {
    const { username, password } = req.body;

    // Check required fields
    if (!username || !password) {
      return res.status(400).json({
        login: false,
        message: "All fields are required",
        err: "missing_data",
      });
    }

    // Check username
    const [users] = await db.execute(
      "SELECT id FROM users WHERE username = ?",
      [username],
    );

    if (users.length > 0) {
      return res.status(409).json({
        login: false,
        message: "Username already exists",
        err: "username_exists",
      });
    }

    // এখান থেকে password hash + INSERT করব

    const hashedPassword = await bcrypt.hash(password, 10);

    // Insert user

    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      // Create user
      const [result] = await connection.execute(
        `INSERT INTO users (username, password)
     VALUES (?, ?)`,
        [username, hashedPassword],
      );

      // Create wallet for the new user
      await connection.execute(
        `INSERT INTO wallets (user_id, balance)
     VALUES (?, ?)`,
        [result.insertId, 0],
      );

      // Both operations succeeded
      await connection.commit();

      // Create token after successful registration
      const token = jwt.sign(
        {
          id: result.insertId,
          username: username,
        },
        process.env.JWT_SECRET,
      );

      return res.status(201).json({
        login: true,
        message: "Registration successful",
        token: token,
      });
    } catch (err) {
      try {
        await connection.rollback();
      } catch (rollbackErr) {
        console.error("Rollback failed:", rollbackErr.message);
      }

      throw err;
    } finally {
      connection.release();
    }
  } catch (err) {
    console.log(err);

    res.status(500).json({
      login: false,
      message: "Server error",
      err: "server_error",
    });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    // Check required fields
    if (!username || !password) {
      return res.status(400).json({
        login: false,
        message: "All fields are required",
        err: "missing_data",
      });
    }

    // Find user
    const [users] = await db.execute(
      `SELECT id, username, password
       FROM users
       WHERE username = ?`,
      [username],
    );

    // Check user exists
    if (users.length === 0) {
      return res.status(401).json({
        login: false,
        message: "Invalid username or password",
        err: "invalid_credentials",
      });
    }

    const user = users[0];

    // Compare password
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(401).json({
        login: false,
        message: "Invalid username or password",
        err: "invalid_credentials",
      });
    }

    // Create JWT token
    const token = jwt.sign(
      {
        id: user.id,
        username: user.username,
      },
      process.env.JWT_SECRET,
    );

    // Login successful
    return res.status(200).json({
      login: true,
      message: "Login successful",
      token: token,
    });
  } catch (err) {
    console.log(err);

    return res.status(500).json({
      login: false,
      message: "Server error",
      err: "server_error",
    });
  }
});

router.get("/me", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        login: false,
        message: "Token not found",
        err: "token_missing",
      });
    }

    const token = authHeader.split(" ")[1];

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const [users] = await db.execute(
      `SELECT 
     users.id,
     users.username,
     wallets.balance
   FROM users
   JOIN wallets ON wallets.user_id = users.id
   WHERE users.id = ?`,
      [decoded.id],
    );

    if (users.length === 0) {
      return res.status(404).json({
        login: false,
        message: "User not found",
        err: "user_not_found",
      });
    }

    res.json({
      login: true,
      user: users[0],
    });
  } catch (err) {
    console.log(err);

    return res.status(401).json({
      login: false,
      message: "Invalid token",
      err: "invalid_token",
    });
  }
});

module.exports = router;
