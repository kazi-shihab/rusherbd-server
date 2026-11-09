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

      WHERE NOT EXISTS (
        SELECT 1
        FROM br_solo_fee10_slot AS s

        LEFT JOIN br_solo_fee10_prize_history AS ph
          ON ph.match_id = s.match_id
          AND ph.user_id = s.user_id

        WHERE s.match_id = m.id
          AND (
            ph.kills IS NOT NULL
            OR ph.placement IS NOT NULL
          )
      )

      AND DATE(m.tournament_time) = ?

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

function calculatePrizePool(totalPlayers, totalKills) {
  if (!Number.isInteger(totalPlayers) || totalPlayers < 2) {
    throw new Error("Total players must be at least 2");
  }

  if (
    !Number.isInteger(totalKills) ||
    totalKills < 0 ||
    totalKills >= totalPlayers
  ) {
    throw new Error("Invalid total kills");
  }

  const entryFee = 10;
  const killPrizePerKill = 5;
  const orgFeePercentage = 9.5;

  const totalEntry = totalPlayers * entryFee;

  const orgFee = Number(((totalEntry * orgFeePercentage) / 100).toFixed(2));

  const totalKillPrize = totalKills * killPrizePerKill;

  const prizePool = Number((totalEntry - orgFee - totalKillPrize).toFixed(2));

  return {
    totalPlayers,
    totalKills,
    totalEntry,
    orgFee,
    totalKillPrize,
    prizePool,
  };
}

function distributeBRsoloPrize(prizePool) {
  if (
    typeof prizePool !== "number" ||
    !Number.isFinite(prizePool) ||
    prizePool < 0
  ) {
    throw new Error("Invalid prize pool");
  }

  const ratios = [30, 24, 20, 16, 10];

  return ratios.map((ratio, index) => ({
    placement: index + 1,
    percentage: ratio,
    amount: Number(((prizePool * ratio) / 100).toFixed(2)),
  }));
}

router.post("/brsolofee10/payment", verifyAdminToken, async (req, res) => {
  let connection;

  try {
    const { matchId, players } = req.body;

    // Basic Validation
    if (!Number.isInteger(matchId) || matchId <= 0 || !Array.isArray(players)) {
      return res.status(400).json({
        success: false,
        message: "Invalid match data",
      });
    }

    if (players.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Players data required",
      });
    }

    connection = await db.getConnection();

    await connection.beginTransaction();

    // 1. Lock and Check Match
    const [matches] = await connection.execute(
      `
        SELECT id, status
        FROM br_solo_fee10
        WHERE id = ?
        FOR UPDATE
        `,
      [matchId],
    );

    if (matches.length === 0) {
      throw new Error("Match not found");
    }

    if (matches[0].status !== "finish") {
      throw new Error("Match is not finished");
    }

    // 2. Get All Joined Players
    const [joinedPlayers] = await connection.execute(
      `
        SELECT user_id
        FROM br_solo_fee10_players
        WHERE match_id = ?
        FOR UPDATE
        `,
      [matchId],
    );

    const totalPlayers = joinedPlayers.length;

    if (totalPlayers < 2) {
      throw new Error("Not enough joined players");
    }

    // 3. Check Existing Prize History
    const [existingHistory] = await connection.execute(
      `
        SELECT id
        FROM br_solo_fee10_prize_history
        WHERE match_id = ?
        LIMIT 1
        `,
      [matchId],
    );

    if (existingHistory.length > 0) {
      throw new Error("Prize history already exists");
    }

    // 4. Create or Get Payment Status
    await connection.execute(
      `
        INSERT IGNORE INTO match_payment_status
          (match_id, match_type)
        VALUES (?, ?)
        `,
      [matchId, "br_solo_fee10"],
    );

    const [paymentStatus] = await connection.execute(
      `
        SELECT payment_status
        FROM match_payment_status
        WHERE match_id = ?
          AND match_type = ?
        FOR UPDATE
        `,
      [matchId, "br_solo_fee10"],
    );

    if (
      paymentStatus.length === 0 ||
      paymentStatus[0].payment_status === "completed"
    ) {
      throw new Error("Match payment already completed");
    }

    // 5. Validate Frontend Player Count
    if (players.length !== totalPlayers) {
      throw new Error("Result must include every joined player");
    }

    // 6. Validate User IDs, Kills and Placement
    const joinedUserIds = new Set(joinedPlayers.map((p) => Number(p.user_id)));

    const receivedUserIds = new Set();
    const placements = new Set();

    let totalKills = 0;

    for (const player of players) {
      const { userId, kills, placement } = player;

      if (!Number.isInteger(userId) || !joinedUserIds.has(userId)) {
        throw new Error("Invalid or unregistered player");
      }

      if (receivedUserIds.has(userId)) {
        throw new Error("Duplicate user ID");
      }

      receivedUserIds.add(userId);

      if (!Number.isInteger(kills) || kills < 0) {
        throw new Error("Invalid player kills");
      }

      if (
        !Number.isInteger(placement) ||
        placement < 1 ||
        placement > totalPlayers
      ) {
        throw new Error("Invalid player placement");
      }

      if (placements.has(placement)) {
        throw new Error("Duplicate placement found");
      }

      placements.add(placement);

      totalKills += kills;
    }

    // 7. Validate Total Kills
    if (totalKills >= totalPlayers) {
      throw new Error("Total kills cannot equal or exceed total players");
    }

    // 8. Calculate Prize Pool
    const prizeData = calculatePrizePool(totalPlayers, totalKills);

    const placementPrizes = distributeBRsoloPrize(prizeData.prizePool);

    const placementPrizeMap = new Map(
      placementPrizes.map((p) => [p.placement, p.amount]),
    );

    // 9. Calculate Each Player's Total Prize
    const paymentData = players.map((player) => {
      const killPrize = player.kills * 5;

      const placementPrize = placementPrizeMap.get(player.placement) || 0;

      const prizeAmount = Number((killPrize + placementPrize).toFixed(2));

      return {
        userId: player.userId,
        kills: player.kills,
        placement: player.placement,
        prizeAmount,
      };
    });

    // 10. Update Wallet and Save Prize History
    for (const player of paymentData) {
      // Check and Lock Wallet
      const [wallets] = await connection.execute(
        `
          SELECT balance
          FROM wallets
          WHERE user_id = ?
          FOR UPDATE
          `,
        [player.userId],
      );

      if (wallets.length === 0) {
        throw new Error(`Wallet not found for user ${player.userId}`);
      }

      // Add Prize to Wallet
      await connection.execute(
        `
          UPDATE wallets
          SET balance = balance + ?
          WHERE user_id = ?
          `,
        [player.prizeAmount, player.userId],
      );

      // Save Prize History
      await connection.execute(
        `
          INSERT INTO br_solo_fee10_prize_history
          (
            match_id,
            user_id,
            placement,
            kills,
            prize_amount,
            payout_status,
            paid_at
          )
          VALUES (?, ?, ?, ?, ?, 'paid', CURRENT_TIMESTAMP)
          `,
        [
          matchId,
          player.userId,
          player.placement,
          player.kills,
          player.prizeAmount,
        ],
      );
    }

    // 11. Mark Match Payment Completed
    await connection.execute(
      `
        UPDATE match_payment_status
        SET payment_status = 'completed',
            completed_at = CURRENT_TIMESTAMP
        WHERE match_id = ?
          AND match_type = ?
        `,
      [matchId, "br_solo_fee10"],
    );

    // 12. Commit Everything
    await connection.commit();

    return res.status(200).json({
      success: true,
      message: "All player payments completed successfully",

      matchId,

      totalPlayers,
      totalKills,

      prizeData,

      players: paymentData,
    });
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }

    console.error("BR Solo Payment Error:", error);

    return res.status(400).json({
      success: false,
      message: error.message || "Payment failed",
    });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

module.exports = router;
