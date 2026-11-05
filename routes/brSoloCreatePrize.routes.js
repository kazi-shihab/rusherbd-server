const express = require("express");
const db = require("../db");
const verifyAdminToken = require("../middleware/verifyAdminToken");

const router = express.Router();

// Prize rules
const ORGANIZATION_PERCENTAGE = 9.4;
const KILL_PRIZE_PAISA = 500; // 5 BDT
const POSITION_PERCENTAGES = [35, 25, 18, 12, 10];

// Convert DB decimal value to paisa
function toPaisa(value) {
  const [whole, fraction = ""] = String(value).split(".");

  return Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
}

// Convert paisa to MySQL decimal string
function fromPaisa(value) {
  return (value / 100).toFixed(2);
}

// Calculate position prizes using largest remainder
function calculatePositionPrizes(positionPoolPaisa) {
  const prizes = POSITION_PERCENTAGES.map((percentage, index) => {
    const exactAmount = (positionPoolPaisa * percentage) / 100;

    return {
      position: index + 1,
      amount: Math.floor(exactAmount),
      remainder: exactAmount - Math.floor(exactAmount),
    };
  });

  const allocated = prizes.reduce((total, prize) => total + prize.amount, 0);

  let remaining = positionPoolPaisa - allocated;

  const sorted = [...prizes].sort((a, b) => b.remainder - a.remainder);

  for (let i = 0; i < remaining; i++) {
    sorted[i].amount += 1;
  }

  return prizes;
}

// Create Match Prize
router.post(
  "/admin/matches/:matchId/create-prize",
  verifyAdminToken,
  async (req, res) => {
    const connection = await db.getConnection();

    try {
      const matchId = Number(req.params.matchId);
      const { results } = req.body;

      if (!Number.isInteger(matchId) || matchId <= 0) {
        return res.status(400).json({
          success: false,
          message: "Invalid match ID",
        });
      }

      if (!Array.isArray(results)) {
        return res.status(400).json({
          success: false,
          message: "Results array required",
        });
      }

      await connection.beginTransaction();

      // 1. Lock match
      const [matches] = await connection.execute(
        `SELECT id, entry_fee, status
         FROM br_solo_fee10
         WHERE id = ?
         FOR UPDATE`,
        [matchId],
      );

      if (!matches.length) {
        throw new Error("MATCH_NOT_FOUND");
      }

      const match = matches[0];

      if (match.status === "cancelled" || match.status === "finish") {
        throw new Error("MATCH_ALREADY_FINISHED_OR_CANCELLED");
      }

      // 2. Get all joined players from database
      const [players] = await connection.execute(
        `SELECT
           s.user_id,
           s.slot_number,
           s.in_game_name,
           u.username
         FROM br_solo_fee10_slot s
         LEFT JOIN users u ON u.id = s.user_id
         WHERE s.match_id = ?
         ORDER BY s.slot_number ASC`,
        [matchId],
      );

      const totalJoinedPlayers = players.length;

      if (totalJoinedPlayers < 5) {
        throw new Error("NOT_ENOUGH_PLAYERS");
      }

      if (players.some((player) => !player.username)) {
        throw new Error("PLAYER_ACCOUNT_NOT_FOUND");
      }

      // 3. Check existing prize history
      const [existingPrize] = await connection.execute(
        `SELECT id
         FROM br_solo_fee10_prize_history
         WHERE match_id = ?
         LIMIT 1`,
        [matchId],
      );

      if (existingPrize.length) {
        throw new Error("PRIZE_ALREADY_CREATED");
      }

      // 4. Validate submitted results
      if (results.length !== totalJoinedPlayers) {
        throw new Error("PLAYER_RESULT_COUNT_MISMATCH");
      }

      const resultMap = new Map();

      for (const result of results) {
        const userId = String(result.user_id);

        if (!userId || resultMap.has(userId)) {
          throw new Error("DUPLICATE_OR_INVALID_USER");
        }

        const position =
          result.position === null ||
          result.position === "" ||
          result.position === undefined
            ? null
            : Number(result.position);

        const kills = Number(result.kills);

        if (
          position !== null &&
          (!Number.isInteger(position) || position < 1 || position > 5)
        ) {
          throw new Error("INVALID_POSITION");
        }

        if (!Number.isInteger(kills) || kills < 0) {
          throw new Error("INVALID_KILLS");
        }

        resultMap.set(userId, {
          position,
          kills,
        });
      }

      // 5. Make sure every database player is included
      const playerResults = [];

      for (const player of players) {
        const userId = String(player.user_id);
        const result = resultMap.get(userId);

        if (!result) {
          throw new Error("PLAYER_RESULT_MISSING");
        }

        playerResults.push({
          user_id: player.user_id,
          position: result.position,
          kills: result.kills,
        });
      }

      // 6. Validate unique positions
      const positions = playerResults
        .filter((player) => player.position !== null)
        .map((player) => player.position);

      if (new Set(positions).size !== positions.length) {
        throw new Error("DUPLICATE_POSITION");
      }

      // All top 5 positions must be assigned
      for (let position = 1; position <= 5; position++) {
        if (!positions.includes(position)) {
          throw new Error("TOP_FIVE_POSITION_MISSING");
        }
      }

      // 7. Validate maximum kills
      const totalKills = playerResults.reduce(
        (total, player) => total + player.kills,
        0,
      );

      const maximumKills = totalJoinedPlayers - 1;

      if (totalKills > maximumKills) {
        throw new Error("MAXIMUM_KILLS_EXCEEDED");
      }

      // 8. Calculate prizes from database values
      const entryFeePaisa = toPaisa(match.entry_fee);

      if (entryFeePaisa <= 0) {
        throw new Error("INVALID_ENTRY_FEE");
      }

      const totalEntryPaisa = totalJoinedPlayers * entryFeePaisa;

      const maximumKillPrizePaisa = maximumKills * KILL_PRIZE_PAISA;

      const organizationFeePaisa = Math.round(
        (totalEntryPaisa * ORGANIZATION_PERCENTAGE) / 100,
      );

      const positionPoolPaisa =
        totalEntryPaisa - organizationFeePaisa - maximumKillPrizePaisa;

      if (positionPoolPaisa < 0) {
        throw new Error("INSUFFICIENT_PRIZE_POOL");
      }

      const positionPrizes = calculatePositionPrizes(positionPoolPaisa);

      const positionPrizeMap = new Map(
        positionPrizes.map((item) => [item.position, item.amount]),
      );

      const actualKillPrizePaisa = totalKills * KILL_PRIZE_PAISA;

      const unusedKillPrizePaisa = maximumKillPrizePaisa - actualKillPrizePaisa;

      const finalOrganizationAmountPaisa =
        organizationFeePaisa + unusedKillPrizePaisa;

      // 9. Calculate each player's final prize
      const payoutResults = playerResults.map((player) => {
        const killPrize = player.kills * KILL_PRIZE_PAISA;

        const positionPrize =
          player.position === null ? 0 : positionPrizeMap.get(player.position);

        return {
          ...player,
          prizeAmount: killPrize + positionPrize,
        };
      });

      // 10. Lock all player wallets
      const userIds = players.map((player) => player.user_id);

      const placeholders = userIds.map(() => "?").join(",");

      const [wallets] = await connection.execute(
        `SELECT user_id, balance
         FROM wallets
         WHERE user_id IN (${placeholders})
         FOR UPDATE`,
        userIds,
      );

      if (wallets.length !== totalJoinedPlayers) {
        throw new Error("PLAYER_WALLET_MISSING");
      }

      // 11. Insert prize history and update wallets
      for (const player of payoutResults) {
        await connection.execute(
          `INSERT INTO br_solo_fee10_prize_history
           (
             match_id,
             user_id,
             placement,
             kills,
             prize_amount,
             payout_status,
             paid_at
           )
           VALUES (?, ?, ?, ?, ?, 'paid', NOW())`,
          [
            matchId,
            player.user_id,
            player.position,
            player.kills,
            fromPaisa(player.prizeAmount),
          ],
        );

        if (player.prizeAmount > 0) {
          await connection.execute(
            `UPDATE wallets
             SET balance = balance + ?
             WHERE user_id = ?`,
            [fromPaisa(player.prizeAmount), player.user_id],
          );
        }
      }

      // 12. Mark match as finished
      await connection.execute(
        `UPDATE br_solo_fee10
         SET status = 'finish'
         WHERE id = ?`,
        [matchId],
      );

      // 13. Commit everything
      await connection.commit();

      return res.json({
        success: true,
        message: "Match prize created successfully",

        summary: {
          matchId,
          totalJoinedPlayers,
          entryFee: fromPaisa(entryFeePaisa),
          totalEntryAmount: fromPaisa(totalEntryPaisa),
          totalKills,
          maximumKills,
          maximumKillPrize: fromPaisa(maximumKillPrizePaisa),
          actualKillPrize: fromPaisa(actualKillPrizePaisa),
          positionPrizePool: fromPaisa(positionPoolPaisa),
          organizationAmount: fromPaisa(finalOrganizationAmountPaisa),
        },

        players: payoutResults.map((player) => ({
          user_id: player.user_id,
          position: player.position,
          kills: player.kills,
          prizeAmount: fromPaisa(player.prizeAmount),
        })),
      });
    } catch (error) {
      await connection.rollback();

      console.error("Create Prize Error:", error);

      const errors = {
        MATCH_NOT_FOUND: [404, "Match not found"],
        MATCH_ALREADY_FINISHED_OR_CANCELLED: [
          400,
          "Match already finished or cancelled",
        ],
        NOT_ENOUGH_PLAYERS: [400, "At least 5 joined players are required"],
        PLAYER_ACCOUNT_NOT_FOUND: [
          400,
          "A joined player's account was not found",
        ],
        PRIZE_ALREADY_CREATED: [409, "Prize already created for this match"],
        PLAYER_RESULT_COUNT_MISMATCH: [
          400,
          "Every joined player must have a result",
        ],
        DUPLICATE_OR_INVALID_USER: [400, "Duplicate or invalid user ID"],
        INVALID_POSITION: [400, "Position must be between 1 and 5, or null"],
        INVALID_KILLS: [400, "Kills must be a non-negative integer"],
        PLAYER_RESULT_MISSING: [400, "A joined player's result is missing"],
        DUPLICATE_POSITION: [400, "Duplicate position found"],
        TOP_FIVE_POSITION_MISSING: [
          400,
          "All top five positions must be assigned",
        ],
        MAXIMUM_KILLS_EXCEEDED: [400, "Total kills exceeded the maximum"],
        INVALID_ENTRY_FEE: [400, "Invalid match entry fee"],
        INSUFFICIENT_PRIZE_POOL: [400, "Insufficient prize pool"],
        PLAYER_WALLET_MISSING: [400, "A joined player's wallet was not found"],
      };

      const knownError = errors[error.message];

      return res.status(knownError ? knownError[0] : 500).json({
        success: false,
        message: knownError ? knownError[1] : "Failed to create match prize",
      });
    } finally {
      connection.release();
    }
  },
);

module.exports = router;
