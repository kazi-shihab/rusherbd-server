const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../db");

const router = express.Router();

// 1. Verify user token
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

// 2. Test router
router.get("/test", (req, res) => {
  res.json({
    success: true,
    message: "BR Duo Fee 10 router is working",
  });
});

// 3. Get today's matches

router.get("/matches", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;

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
          FROM br_duo_fee10_slot p
          WHERE p.match_id = m.id
        ) AS joined_players,

        EXISTS (
          SELECT 1
          FROM br_duo_fee10_slot p
          WHERE p.match_id = m.id
            AND p.user_id = ?
        ) AS is_joined

      FROM br_duo_fee10 m

      WHERE DATE(m.tournament_time) = CURDATE()

      ORDER BY m.tournament_time ASC
      `,
      [userId],
    );

    return res.json({
      success: true,
      matches,
    });
  } catch (err) {
    // console.error("BR Duo Fee 10 matches error:", err);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch BR Duo Fee 10 matches",
    });
  }
});

// 4. Get match details

router.get("/match-details", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const matchId = Number(req.query.matchId);

    if (!Number.isInteger(matchId) || matchId <= 0) {
      return res.status(400).json({
        message: "Valid match ID is required.",
      });
    }

    // 1. Match details + total booked slots
    const [matches] = await db.execute(
      `
      SELECT
        m.id,
        m.entry_fee,
        m.match_duration,
        m.max_players,
        m.status,
        m.tournament_time,
        COUNT(s.id) AS joined_players
      FROM br_duo_fee10 AS m
      LEFT JOIN br_duo_fee10_slot AS s
        ON s.match_id = m.id
      WHERE m.id = ?
      GROUP BY
        m.id,
        m.entry_fee,
        m.match_duration,
        m.max_players,
        m.status,
        m.tournament_time
      `,
      [matchId],
    );

    if (matches.length === 0) {
      return res.status(404).json({
        message: "Duo match not found.",
      });
    }

    // 2. Check whether the logged-in user joined this match
    const [userSlots] = await db.execute(
      `
      SELECT id, slot_number, in_game_name
      FROM br_duo_fee10_slot
      WHERE match_id = ?
        AND user_id = ?
      ORDER BY slot_number ASC
      `,
      [matchId, userId],
    );

    const match = matches[0];

    return res.status(200).json({
      match: {
        ...match,
        id: Number(match.id),
        entry_fee: Number(match.entry_fee),
        match_duration: Number(match.match_duration),
        max_players: Number(match.max_players),
        joined_players: Number(match.joined_players),
      },
      is_joined: userSlots.length > 0,
      joined_slots: userSlots,
    });
  } catch (error) {
    console.error("Duo match-details error:", error);

    return res.status(500).json({
      message: "Failed to fetch Duo match details.",
    });
  }
});

// 5. Join match

router.post("/:matchId/join", verifyToken, async (req, res) => {
  const connection = await db.getConnection();

  try {
    const userId = req.user.id;
    const matchId = Number(req.params.matchId);
    const { slotCount, gameNames } = req.body;

    // 1. Basic validation
    if (!Number.isInteger(matchId) || matchId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid match ID",
      });
    }

    if (![1, 2].includes(slotCount)) {
      return res.status(400).json({
        success: false,
        message: "You can book 1 or 2 slots",
      });
    }

    if (
      !Array.isArray(gameNames) ||
      gameNames.length !== slotCount ||
      gameNames.some(
        (name) =>
          typeof name !== "string" || !name.trim() || name.trim().length > 50,
      )
    ) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid game name for each slot",
      });
    }

    const names = gameNames.map((name) => name.trim());

    // একই booking-এর দুই slot-এ একই নাম দেওয়া আটকানো
    if (slotCount === 2 && names[0].toLowerCase() === names[1].toLowerCase()) {
      return res.status(400).json({
        success: false,
        message: "Enter two different game names",
      });
    }

    await connection.beginTransaction();

    // 2. Match row lock: একই ম্যাচে concurrent booking serialize হবে
    const [matches] = await connection.execute(
      `SELECT id, entry_fee, max_players, status, tournament_time
       FROM br_duo_fee10
       WHERE id = ?
       FOR UPDATE`,
      [matchId],
    );

    if (matches.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "Match not found",
      });
    }

    const match = matches[0];

    if (
      match.status !== "upcoming" ||
      new Date(match.tournament_time).getTime() <= Date.now()
    ) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: "This match is no longer available",
      });
    }

    // 3. Duplicate booking check
    const [existing] = await connection.execute(
      `SELECT id
       FROM br_duo_fee10_bookings
       WHERE match_id = ? AND user_id = ?
       LIMIT 1`,
      [matchId, userId],
    );

    if (existing.length > 0) {
      await connection.rollback();
      return res.status(409).json({
        success: false,
        message: "You have already booked this match",
      });
    }

    // 3.1 Check whether a Free Fire name already exists
    const placeholders = names.map(() => "?").join(", ");

    const [existingNames] = await connection.execute(
      `SELECT in_game_name
       FROM br_duo_fee10_slot
       WHERE in_game_name IN (${placeholders})
       LIMIT 1`,
      names,
    );

    if (existingNames.length > 0) {
      await connection.rollback();

      return res.status(409).json({
        success: false,
        message:
          "This Free Fire name is already registered. Please use another name.",
      });
    }

    // 4. Find occupied slots
    const [occupiedRows] = await connection.execute(
      `SELECT slot_number
       FROM br_duo_fee10_slot
       WHERE match_id = ?
       ORDER BY slot_number`,
      [matchId],
    );

    const occupied = new Set(
      occupiedRows.map((row) => Number(row.slot_number)),
    );

    const maxPlayers = Number(match.max_players);
    let selectedSlots = [];

    // 1 slot: find first available slot
    if (slotCount === 1) {
      for (let slot = 1; slot <= maxPlayers; slot++) {
        if (!occupied.has(slot)) {
          selectedSlots = [slot];
          break;
        }
      }
    }

    // 2 slots: find two adjacent free slots
    if (slotCount === 2) {
      for (let slot = 1; slot < maxPlayers; slot++) {
        if (!occupied.has(slot) && !occupied.has(slot + 1)) {
          selectedSlots = [slot, slot + 1];
          break;
        }
      }
    }

    if (selectedSlots.length !== slotCount) {
      await connection.rollback();
      return res.status(409).json({
        success: false,
        message:
          slotCount === 2 ? "No two adjacent slots available" : "Match is full",
      });
    }

    // 5. Calculate fee on the backend
    const entryFee = Number(match.entry_fee);

    if (!Number.isFinite(entryFee) || entryFee <= 0) {
      throw new Error("Invalid match entry fee");
    }

    const totalFee = entryFee * slotCount;

    // 6. Lock wallet and check balance
    const [wallets] = await connection.execute(
      `SELECT balance
       FROM wallets
       WHERE user_id = ?
       FOR UPDATE`,
      [userId],
    );

    if (wallets.length === 0) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: "Wallet not found",
      });
    }

    if (Number(wallets[0].balance) < totalFee) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: "Insufficient balance",
      });
    }

    // 7. Deduct fee
    const [walletUpdate] = await connection.execute(
      `UPDATE wallets
       SET balance = balance - ?
       WHERE user_id = ? AND balance >= ?`,
      [totalFee, userId, totalFee],
    );

    if (walletUpdate.affectedRows !== 1) {
      throw new Error("Wallet balance update failed");
    }

    // 8. Create booking
    const [bookingResult] = await connection.execute(
      `INSERT INTO br_duo_fee10_bookings
       (match_id, user_id, slot_count)
       VALUES (?, ?, ?)`,
      [matchId, userId, slotCount],
    );

    const bookingId = bookingResult.insertId;

    // 9. Save each slot
    for (let i = 0; i < slotCount; i++) {
      await connection.execute(
        `INSERT INTO br_duo_fee10_slot
         (booking_id, match_id, user_id, slot_number, in_game_name)
         VALUES (?, ?, ?, ?, ?)`,
        [bookingId, matchId, userId, selectedSlots[i], names[i]],
      );
    }

    // 10. Get remaining balance
    const [updatedWallets] = await connection.execute(
      `SELECT balance FROM wallets WHERE user_id = ?`,
      [userId],
    );

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: "Joined successfully",
      booking: {
        bookingId,
        matchId,
        slotCount,
        slots: selectedSlots.map((slotNumber, i) => ({
          slotNumber,
          gameName: names[i],
        })),
        totalPaid: totalFee,
        remainingBalance: Number(updatedWallets[0].balance),
      },
    });
  } catch (error) {
    await connection.rollback();

    console.error("Duo join error:", error);

    i;
    if (error.code === "ER_DUP_ENTRY") {
      if (error.sqlMessage?.includes("unique_duo_in_game_name")) {
        return res.status(409).json({
          success: false,
          message:
            "This Free Fire name is already registered. Please use another name.",
        });
      }

      return res.status(409).json({
        success: false,
        message: "This booking or slot already exists",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Failed to join match",
    });
  } finally {
    connection.release();
  }
});

// 6. Get user's joined matches

router.get("/mymatch", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const [rows] = await db.execute(
      `
      SELECT
        b.id AS booking_id,
        b.match_id,
        b.slot_count,

        m.tournament_time,
        m.match_duration,
        m.entry_fee,
        m.max_players,
        m.status,

        s.id AS slot_id,
        s.slot_number,
        s.in_game_name,

        CASE
          WHEN m.tournament_time <= DATE_ADD(NOW(), INTERVAL 4 MINUTE)
          THEN r.room_id
          ELSE NULL
        END AS room_id,

        CASE
          WHEN m.tournament_time <= DATE_ADD(NOW(), INTERVAL 4 MINUTE)
          THEN r.room_password
          ELSE NULL
        END AS room_password

      FROM br_duo_fee10_bookings b

      INNER JOIN br_duo_fee10 m
        ON m.id = b.match_id

      INNER JOIN br_duo_fee10_slot s
        ON s.booking_id = b.id
        AND s.match_id = b.match_id
        AND s.user_id = b.user_id

      LEFT JOIN br_duo_fee10_rooms r
        ON r.match_id = m.id

      WHERE b.user_id = ?

      ORDER BY m.tournament_time DESC, s.slot_number ASC
      `,
      [userId],
    );

    const matchesMap = new Map();

    for (const row of rows) {
      if (!matchesMap.has(row.booking_id)) {
        matchesMap.set(row.booking_id, {
          bookingId: row.booking_id,
          matchId: row.match_id,
          slotCount: row.slot_count,
          tournamentTime: row.tournament_time,
          matchDuration: row.match_duration,
          entryFee: Number(row.entry_fee),
          maxPlayers: row.max_players,
          status: row.status,
          roomId: row.room_id,
          roomPassword: row.room_password,
          slots: [],
        });
      }

      matchesMap.get(row.booking_id).slots.push({
        slotId: row.slot_id,
        slotNumber: row.slot_number,
        inGameName: row.in_game_name,
      });
    }

    return res.status(200).json({
      success: true,
      matches: Array.from(matchesMap.values()),
    });
  } catch (error) {
    console.error("Duo mymatch error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch your Duo matches.",
    });
  }
});

module.exports = router;
