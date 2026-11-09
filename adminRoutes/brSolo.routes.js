const express = require("express");
const router = express.Router();

const db = require("../db");
const verifyAdminToken = require("../middleware/verifyAdminToken");

router.post("/brsolofee10/room", verifyAdminToken, async (req, res) => {
  try {
    const { matchId, roomId, roomPassword } = req.body;

    if (!matchId || !roomId || !roomPassword) {
      return res.status(400).json({
        success: false,
        message: "Match ID, Room ID and Password required",
      });
    }

    // Check match
    const [matches] = await db.execute(
      `SELECT id FROM br_solo_fee10 WHERE id = ? LIMIT 1`,
      [matchId],
    );

    if (matches.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Match not found",
      });
    }

    // Create or update room
    await db.execute(
      `INSERT INTO br_solo_fee10_rooms
          (match_id, room_id, room_password)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE
          room_id = VALUES(room_id),
          room_password = VALUES(room_password)`,
      [matchId, roomId, roomPassword],
    );

    return res.json({
      success: true,
      message: "Room created or updated successfully",
    });
  } catch (error) {
    console.error("BR Solo Room Error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

router.get("/brsolofee10", verifyAdminToken, async (req, res) => {
  try {
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Dhaka",
    }).format(new Date());

    const [matches] = await db.execute(
      `
      SELECT
        m.*,
        r.room_id,
        r.room_password

      FROM br_solo_fee10 AS m

      LEFT JOIN br_solo_fee10_rooms AS r
        ON r.match_id = m.id

      AND NOT EXISTS (
        SELECT 1
        FROM br_solo_fee10_players AS p

        LEFT JOIN br_solo_fee10_prize_history AS ph
          ON ph.match_id = p.match_id
          AND ph.user_id = p.user_id

        WHERE p.match_id = m.id
          AND (
            ph.kills IS NOT NULL
            OR ph.placement IS NOT NULL
          )
      )

      ORDER BY m.tournament_time ASC
      `,
      [today],
    );

    return res.status(200).json({
      success: true,
      date: today,
      totalMatches: matches.length,
      matches,
    });
  } catch (error) {
    console.error("Today's BR Solo matches error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch today's BR Solo matches",
    });
  }
});

router.get(
  "/brsolofee10/:matchId/players",
  verifyAdminToken,
  async (req, res) => {
    try {
      const { matchId } = req.params;

      // Validate Match ID
      if (
        !matchId ||
        !Number.isInteger(Number(matchId)) ||
        Number(matchId) <= 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid Match ID",
        });
      }

      // Check Match
      const [matches] = await db.execute(
        `
        SELECT id, tournament_time, status
        FROM br_solo_fee10
        WHERE id = ?
        LIMIT 1
        `,
        [matchId],
      );

      if (matches.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Match not found",
        });
      }

      // Get Joined Players + Prize History
      const [players] = await db.execute(
        `
        SELECT
          p.user_id AS userId,
          u.username,
          p.game_name AS gameName,
          ph.kills,
          ph.placement

        FROM br_solo_fee10_players AS p

        INNER JOIN users AS u
          ON u.id = p.user_id

        LEFT JOIN br_solo_fee10_prize_history AS ph
          ON ph.match_id = p.match_id
          AND ph.user_id = p.user_id

        WHERE p.match_id = ?

        ORDER BY p.slot_number ASC
        `,
        [matchId],
      );

      return res.status(200).json({
        success: true,
        match: matches[0],
        totalPlayers: players.length,
        players,
      });
    } catch (error) {
      console.error("BR Solo Match Players Error:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to fetch match players",
      });
    }
  },
);

module.exports = router;
