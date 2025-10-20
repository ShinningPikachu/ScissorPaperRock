const { v4: uuidv4 } = require('uuid');
const Player = require('./player');
const {
  MOVES,
  BEATS,
  PLAYER_STATUS,
  ROLES,
  ROUND_INTERVAL_MS
} = require('./constants');

class GameState {
  constructor({ roundIntervalMs = ROUND_INTERVAL_MS } = {}) {
    this.roundIntervalMs = roundIntervalMs;
    this.players = new Map();
    this.round = this.createRoundState(1);
    this.roundHistory = [];
    this.lastOutcome = null;
    this.nextRoundAt = null;
  }

  createRoundState(number) {
    return {
      number,
      started: false,
      completed: false,
      startedAt: null,
      completedAt: null,
      outcome: null
    };
  }

  scheduleNextRound(intervalMs = this.roundIntervalMs) {
    if (!intervalMs) {
      this.nextRoundAt = null;
      return;
    }
    const next = new Date(Date.now() + intervalMs).toISOString();
    this.setNextRoundAt(next);
  }

  setNextRoundAt(timestamp) {
    if (!timestamp) {
      this.nextRoundAt = null;
      return;
    }
    this.nextRoundAt = new Date(timestamp).toISOString();
  }

  registerPlayer({ name, role }) {
    const trimmedName = (name || '').trim();
    if (!trimmedName) {
      throw new Error('Player name is required.');
    }

    if (role === ROLES.ADMIN && this.hasAdmin()) {
      throw new Error('An admin is already registered for this game.');
    }

    const id = uuidv4();
    const player = new Player({ id, name: trimmedName, role });
    this.players.set(id, player);
    return player.serialize();
  }

  hasAdmin() {
    for (const player of this.players.values()) {
      if (player.role === ROLES.ADMIN) {
        return true;
      }
    }
    return false;
  }

  isKnownPlayer(playerId) {
    return this.players.has(playerId);
  }

  getPlayer(playerId) {
    const player = this.players.get(playerId);
    if (!player) {
      throw new Error('Player not found.');
    }
    return player;
  }

  setPlayerMove(playerId, move) {
    const normalizedMove = (move || '').toLowerCase();
    if (!Object.values(MOVES).includes(normalizedMove)) {
      throw new Error('Invalid move selection.');
    }

    const player = this.getPlayer(playerId);
    if (player.role !== ROLES.PLAYER) {
      throw new Error('Admins cannot submit a move.');
    }

    if (this.round.started) {
      throw new Error('Round already started. Moves can no longer be changed.');
    }

    player.setMove(normalizedMove);
    return player.serialize();
  }

  startRound({
    adminId,
    triggeredBy = 'manual',
    requireAllReady = true,
    skipAdminValidation = false,
    penalizeInactive = true
  } = {}) {
    if (!skipAdminValidation) {
      if (!adminId) {
        throw new Error('Admin ID is required to start the round.');
      }
      const admin = this.getPlayer(adminId);
      if (admin.role !== ROLES.ADMIN) {
        throw new Error('Only an admin can start the round.');
      }
    } else if (adminId) {
      this.getPlayer(adminId); // fail early if id invalid
    }

    if (this.round.started) {
      throw new Error('Round already in progress or completed.');
    }

    const participants = this.getParticipants();
    if (participants.length < 2) {
      if (skipAdminValidation) {
        return this.finalizeRound(
          {
            status: 'skipped',
            message: 'Not enough players to run a round.',
            winningMoves: [],
            eliminatedPlayerIds: [],
            winnerPlayerIds: [],
            inactivePlayerIds: []
          },
          triggeredBy,
          { roundExecuted: false }
        );
      }
      throw new Error('At least two players are required to start.');
    }

    const readyPlayers = participants.filter((player) => player.move);
    const inactivePlayers = participants.filter((player) => !player.move);

    if (requireAllReady && inactivePlayers.length > 0) {
      throw new Error('All players must choose a move before starting.');
    }

    if (readyPlayers.length === 0) {
      if (!requireAllReady) {
        const inactivePenalty = penalizeInactive
          ? this.applyInactivePenalty(inactivePlayers)
          : [];
        return this.finalizeRound(
          {
            status: 'skipped',
            message: 'No players submitted a move. Round skipped.',
            winningMoves: [],
            eliminatedPlayerIds: [],
            winnerPlayerIds: [],
            inactivePlayerIds: inactivePenalty
          },
          triggeredBy,
          { roundExecuted: false }
        );
      }

      throw new Error('At least one player must choose a move.');
    }

    const outcome = this.resolveRound(readyPlayers);
    const inactivePenalty = penalizeInactive
      ? this.applyInactivePenalty(inactivePlayers)
      : [];
    outcome.inactivePlayerIds = inactivePenalty;

    return this.finalizeRound(outcome, triggeredBy, { roundExecuted: true });
  }

  getParticipants() {
    return Array.from(this.players.values()).filter(
      (player) => player.role === ROLES.PLAYER
    );
  }

  resolveRound(participants) {
    if (participants.length === 1) {
      const solo = participants[0];
      solo.markWinner();
      return {
        status: 'completed',
        message: `${solo.name} wins by default as the only player ready.`,
        winningMoves: [solo.move],
        eliminatedPlayerIds: [],
        winnerPlayerIds: [solo.id]
      };
    }

    const movesChosen = new Set(participants.map((player) => player.move));

    if (movesChosen.size === 1) {
      participants.forEach((player) => {
        player.status = PLAYER_STATUS.READY;
      });
      const [move] = movesChosen;
      return {
        status: 'tie',
        message: `Everyone picked ${move}. No one moves layers.`,
        winningMoves: [],
        eliminatedPlayerIds: [],
        winnerPlayerIds: []
      };
    }

    if (movesChosen.size === 3) {
      participants.forEach((player) => {
        player.status = PLAYER_STATUS.READY;
      });
      return {
        status: 'tie',
        message: 'All three moves were chosen. No one moves layers.',
        winningMoves: [],
        eliminatedPlayerIds: [],
        winnerPlayerIds: []
      };
    }

    const [moveA, moveB] = Array.from(movesChosen);
    const winningMove = BEATS[moveA] === moveB ? moveA : moveB;
    const losingMove = winningMove === moveA ? moveB : moveA;

    const eliminated = [];
    const winners = [];

    participants.forEach((player) => {
      if (player.move === winningMove) {
        player.markWinner();
        winners.push(player.id);
      } else if (player.move === losingMove) {
        player.eliminate();
        eliminated.push(player.id);
      }
    });

    return {
      status: 'completed',
      message: `Players with ${winningMove} beat ${losingMove}.`,
      winningMoves: [winningMove],
      eliminatedPlayerIds: eliminated,
      winnerPlayerIds: winners
    };
  }

  applyInactivePenalty(inactivePlayers) {
    if (!inactivePlayers.length) {
      return [];
    }
    const penalized = [];
    inactivePlayers.forEach((player) => {
      player.markInactive();
      penalized.push(player.id);
    });
    return penalized;
  }

  finalizeRound(outcome, triggeredBy, { roundExecuted }) {
    const nowIso = new Date().toISOString();
    const startedAt = roundExecuted ? nowIso : null;

    const fullOutcome = {
      ...outcome,
      roundNumber: this.round.number,
      triggeredBy,
      startedAt,
      completedAt: nowIso
    };

    this.round.started = roundExecuted;
    this.round.completed = true;
    this.round.startedAt = startedAt;
    this.round.completedAt = nowIso;
    this.round.outcome = fullOutcome;
    this.lastOutcome = fullOutcome;

    this.roundHistory.push({
      number: this.round.number,
      started: roundExecuted,
      startedAt,
      completedAt: nowIso,
      outcome: fullOutcome
    });

    const nextNumber = this.round.number + 1;
    this.round = this.createRoundState(nextNumber);

    return fullOutcome;
  }

  getPublicState() {
    return {
      players: Array.from(this.players.values()).map((player) =>
        player.serialize()
      ),
      round: { ...this.round },
      lastOutcome: this.lastOutcome,
      nextRoundStartsAt: this.nextRoundAt,
      roundIntervalMs: this.roundIntervalMs
    };
  }

  resetGame() {
    this.players.clear();
    this.round = this.createRoundState(1);
    this.roundHistory = [];
    this.lastOutcome = null;
    this.nextRoundAt = null;
  }
}

module.exports = GameState;
