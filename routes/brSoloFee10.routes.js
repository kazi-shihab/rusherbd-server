const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../db");

const router = express.Router();

// Verify user's token
function verifyToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Token required",
      });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: "Invalid token",
    });
  }
}

// Get all BR Solo Fee 10 matches
router.get("/test", (req, res) => {
  res.json({
    success: true,
    message: "BR Solo Fee 10 router is working",
  });
});

router.get("/matches", verifyToken, async (req, res) => {
  try {
    const [matches] = await db.execute(
      `
  SELECT
    m.id,
    m.tournament_time,
    m.match_duration,
    m.entry_fee,
    m.max_players,
    m.status,

    (
      SELECT COUNT(*)
      FROM br_solo_fee10_slot p
      WHERE p.match_id = m.id
    ) AS joined_players,

    EXISTS (
      SELECT 1
      FROM br_solo_fee10_slot p
      WHERE p.match_id = m.id
        AND p.user_id = ?
    ) AS is_joined

  FROM br_solo_fee10 m
  WHERE DATE(m.tournament_time) = CURDATE()
  ORDER BY m.tournament_time ASC
  `,
      [req.user.id],
    );

    return res.json({
      success: true,
      matches,
    });
  } catch (err) {
    console.error("Get matches error:", err);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch matches",
    });
  }
});

router.get("/match-details", verifyToken, async (req, res) => {
  try {
    const matchId = Number(req.query.matchId);
    const matchType = req.query.matchType;

    // Frontend type -> Database tables
    const tables = {
      "br-solo-fee10": {
        match: "br_solo_fee10",
        slot: "br_solo_fee10_slot",
      },
      "br-solo-fee20": {
        match: "br_solo_fee20",
        slot: "br_solo_fee20_slot",
      },
    };

    const table = tables[matchType];

    // Validate match ID
    if (!Number.isInteger(matchId) || matchId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid match ID",
      });
    }

    // Validate match type
    if (!table) {
      return res.status(400).json({
        success: false,
        message: "Invalid match type",
      });
    }

    // Fetch match details with joined players
    const [rows] = await db.execute(
      `
      SELECT
        m.*,

        (
          SELECT COUNT(*)
          FROM \`${table.slot}\` p
          WHERE p.match_id = m.id
        ) AS joined_players,

        EXISTS (
          SELECT 1
          FROM \`${table.slot}\` p
          WHERE p.match_id = m.id
            AND p.user_id = ?
        ) AS is_joined

      FROM \`${table.match}\` m
      WHERE m.id = ?
      LIMIT 1
      `,
      [req.user.id, matchId],
    );

    // Match not found
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Match not found",
      });
    }

    return res.json({
      success: true,
      match: rows[0],
    });
  } catch (err) {
    console.error("Match details error:", err);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch match details",
    });
  }
});

// Tournament join route (existing)

router.post("/join", verifyToken, async (req, res) => {
  const userId = req.user.id;
  const matchId = Number(req.body.matchId);
  const inGameName =
    typeof req.body.inGameName === "string" ? req.body.inGameName.trim() : "";

  if (!Number.isSafeInteger(matchId) || matchId <= 0) {
    return res.status(400).json({
      success: false,
      message: "Invalid match ID.",
    });
  }

  if (!inGameName || inGameName.length > 100) {
    return res.status(400).json({
      success: false,
      message: "Please enter a valid in-game name.",
    });
  }

  let connection;

  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    // 1. Lock and check the match
    const [matches] = await connection.query(
      `SELECT id, entry_fee, max_players, status
       FROM br_solo_fee10
       WHERE id = ?
       FOR UPDATE`,
      [matchId],
    );

    if (matches.length === 0) {
      await connection.rollback();

      return res.status(404).json({
        success: false,
        message: "Match not found.",
      });
    }

    const match = matches[0];
    const maxPlayers = Number(match.max_players);

    if (match.status !== "upcoming") {
      await connection.rollback();

      return res.status(400).json({
        success: false,
        message: "This match is not open for joining.",
      });
    }

    // 2. Check for an existing participant
    const [existing] = await connection.query(
      `SELECT id
       FROM br_solo_fee10_slot
       WHERE match_id = ? AND user_id = ?
       LIMIT 1`,
      [matchId, userId],
    );

    if (existing.length > 0) {
      await connection.rollback();

      return res.status(409).json({
        success: false,
        message: "You have already joined this match.",
      });
    }

    // Check whether the in-game name is already used in this match
    const [existingNames] = await connection.query(
      `SELECT id
   FROM br_solo_fee10_slot
   WHERE match_id = ?
     AND in_game_name = ?
   LIMIT 1`,
      [matchId, inGameName],
    );

    if (existingNames.length > 0) {
      await connection.rollback();

      return res.status(409).json({
        success: false,
        message: "This in-game name is already used in this match.",
      });
    }

    // 3. Lock and check the user's wallet
    const [wallets] = await connection.query(
      `SELECT balance
       FROM wallets
       WHERE user_id = ?
       FOR UPDATE`,
      [userId],
    );

    if (wallets.length === 0) {
      await connection.rollback();

      return res.status(404).json({
        success: false,
        message: "Wallet not found.",
      });
    }

    const balance = Number(wallets[0].balance);
    const entryFee = Number(match.entry_fee);

    if (balance < entryFee) {
      await connection.rollback();

      return res.status(400).json({
        success: false,
        message: "Insufficient balance. Please add money to your wallet.",
        data: {
          balance,
          entryFee,
          requiredAmount: Number((entryFee - balance).toFixed(2)),
        },
      });
    }

    // 4. Find an available slot
    const [slots] = await connection.query(
      `SELECT slot_number
       FROM br_solo_fee10_slot
       WHERE match_id = ?
       ORDER BY slot_number ASC`,
      [matchId],
    );

    const occupiedSlots = new Set(slots.map((row) => Number(row.slot_number)));

    if (occupiedSlots.size >= maxPlayers) {
      await connection.rollback();

      return res.status(409).json({
        success: false,
        message: "This match is full.",
      });
    }

    let slotNumber = 0;

    for (let i = 1; i <= maxPlayers; i++) {
      if (!occupiedSlots.has(i)) {
        slotNumber = i;
        break;
      }
    }

    if (slotNumber === 0) {
      await connection.rollback();

      return res.status(409).json({
        success: false,
        message: "No available slot.",
      });
    }

    // 5. Deduct the entry fee
    const [deduction] = await connection.query(
      `UPDATE wallets
       SET balance = balance - ?
       WHERE user_id = ?
         AND balance >= ?`,
      [entryFee, userId, entryFee],
    );

    if (deduction.affectedRows !== 1) {
      throw new Error("Wallet balance update failed.");
    }

    // 6. Save the participant and assigned slot
    await connection.query(
      `INSERT INTO br_solo_fee10_slot
       (match_id, user_id, slot_number, in_game_name)
       VALUES (?, ?, ?, ?)`,
      [matchId, userId, slotNumber, inGameName],
    );

    // 7. Read the updated balance
    const [updatedWallets] = await connection.query(
      `SELECT balance
       FROM wallets
       WHERE user_id = ?`,
      [userId],
    );

    const updatedBalance = Number(updatedWallets[0].balance);

    // 8. Commit all changes together
    await connection.commit();

    return res.status(201).json({
      success: true,
      message: "Successfully joined the match.",
      data: {
        matchId,
        userId,
        inGameName,
        slotNumber,
        entryFee,
        balance: updatedBalance,
        maxPlayers,
      },
    });
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }

    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        success: false,
        message: "You have already joined this match.",
      });
    }

    console.error("br_solo_fee10 join error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to join the match right now.",
    });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

router.get("/mymatch", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const [matches] = await db.execute(
      `
      SELECT
        m.id AS match_id,
        'br-solo-fee10' AS match_type,
        m.tournament_time,
        m.match_duration,
        m.entry_fee,
        m.max_players,
        m.status,
        p.slot_number,
        p.in_game_name,

        r.room_id,
        r.room_password

      FROM br_solo_fee10_slot p

      INNER JOIN br_solo_fee10 m
        ON m.id = p.match_id

      LEFT JOIN br_solo_fee10_rooms r
        ON r.match_id = m.id

      WHERE p.user_id = ?

      AND NOT EXISTS (
        SELECT 1
        FROM br_solo_fee10_prize_history ph
        WHERE ph.match_id = m.id
      )

      ORDER BY m.tournament_time DESC
      `,
      [userId],
    );

    return res.json({
      success: true,
      total: matches.length,
      matches,
    });
  } catch (err) {
    console.error("BR Solo Fee 10 MyMatch error:", err);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch BR Solo Fee 10 matches",
    });
  }
});

module.exports = router;
