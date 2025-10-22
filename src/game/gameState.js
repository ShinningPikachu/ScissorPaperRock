const { v4: uuidv4 } = require('uuid');
const Player = require('./player');
const {
  MOVES,
  BEATS,
  ROLES,
  ROUND_INTERVAL_MS,
  PROCESS_STAGE_DURATION_MS,
  COMPETITION_STAGE_DURATION_MS,
  MIN_STAGE,
  MAX_STAGE
} = require('./constants');

class GameState {
  constructor({
    roundIntervalMs = ROUND_INTERVAL_MS,
    processStageMs = PROCESS_STAGE_DURATION_MS,
    competitionStageMs = COMPETITION_STAGE_DURATION_MS
  } = {}) {
    this.roundIntervalMs = roundIntervalMs;
    this.processStageMs = processStageMs;
    this.competitionStageMs = competitionStageMs;
    this.players = new Map();
    this.round = this.createRoundState(1);
    this.roundHistory = [];
    this.lastOutcome = null;
    this.nextRoundAt = null;
    this.pendingOutcome = null;
    this.botCounter = 1;
  }

  createRoundState(number) {
    return {
      number,
      started: false,
      completed: false,
      startedAt: null,
      completedAt: null,
      outcome: null,
      phase: 'waiting',
      phaseEndsAt: null
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

  registerPlayer({ name, role, isBot = false }) {
    const trimmedName = (name || '').trim();
    if (!trimmedName) {
      throw new Error('Player name is required.');
    }

    if (role === ROLES.ADMIN && this.hasAdmin()) {
      throw new Error('An admin is already registered for this game.');
    }

    const id = uuidv4();
    const player = new Player({ id, name: trimmedName, role, isBot });
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

  setPlayerMove(playerId, move, stage = null) {
    const normalizedMove = (move || '').toLowerCase();
    const player = this.getPlayer(playerId);
    if (player.role !== ROLES.PLAYER) {
      throw new Error('Admins cannot submit a move.');
    }

    if (this.round.started) {
      throw new Error('Round already started. Moves can no longer be changed.');
    }

    const stageValue = stage === null || stage === undefined ? player.layer : stage;
    const parsedStage = Number.parseInt(stageValue, 10);
    if (!Number.isFinite(parsedStage)) {
      throw new Error('Invalid stage value.');
    }

    if (parsedStage > MAX_STAGE || parsedStage < MIN_STAGE) {
      throw new Error(`Stage must be between ${MIN_STAGE} and ${MAX_STAGE}.`);
    }

    if (normalizedMove && !Object.values(MOVES).includes(normalizedMove)) {
      throw new Error('Invalid move selection.');
    }

    player.setMove(normalizedMove || null, parsedStage);
    return player.serialize();
  }

  startRound({
    adminId,
    triggeredBy = 'manual',
    requireAllReady = true,
    skipAdminValidation = false,
    penalizeInactive = true
  } = {}) {
    if (this.pendingOutcome) {
      throw new Error('Round already in progress.');
    }

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

    this.assignBotMoves();

    const participants = this.getParticipants();
    if (participants.length < 2) {
      if (skipAdminValidation) {
        return {
          pending: false,
          outcome: this.finalizeRound(
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
          )
        };
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
        return {
          pending: false,
          outcome: this.finalizeRound(
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
          )
        };
      }

      throw new Error('At least one player must choose a move.');
    }

    const outcome = this.resolveRound(readyPlayers);
    const inactivePenalty = penalizeInactive
      ? this.applyInactivePenalty(inactivePlayers)
      : [];
    outcome.inactivePlayerIds = inactivePenalty;

    const startedAt = new Date().toISOString();
    this.round.started = true;
    this.round.completed = false;
    this.round.startedAt = startedAt;
    this.round.phase = 'processing';
    this.round.phaseEndsAt = new Date(Date.now() + this.processStageMs).toISOString();
    this.round.outcome = null;
    this.setNextRoundAt(null);

    this.pendingOutcome = {
      outcome,
      triggeredBy,
      options: { roundExecuted: true, startedAt }
    };

    if (this.processStageMs <= 0 && this.competitionStageMs <= 0) {
      const finalOutcome = this.completePendingRound();
      return {
        pending: false,
        outcome: finalOutcome
      };
    }

    return {
      pending: true,
      outcome: {
        status: 'pending',
        message: 'Round started. Resolving soon.',
        roundNumber: this.round.number,
        triggeredBy,
        startedAt
      }
    };
  }

  getParticipants() {
    return Array.from(this.players.values()).filter(
      (player) => player.role === ROLES.PLAYER
    );
  }

  assignBotMoves() {
    const moveOptions = Object.values(MOVES);
    if (!moveOptions.length) {
      return;
    }

    for (const player of this.players.values()) {
      if (player.role === ROLES.PLAYER && player.isBot) {
        const nextMove = moveOptions[Math.floor(Math.random() * moveOptions.length)];
        player.setMove(nextMove);
      }
    }
  }

  generateBotName() {
    while (true) {
      const padded = this.botCounter.toString().padStart(2, '0');
      this.botCounter += 1;
      const candidate = `Bot ${padded}`;

      const exists = Array.from(this.players.values()).some(
        (player) => player.name === candidate
      );

      if (!exists) {
        return candidate;
      }
    }
  }

  addBots(count) {
    const requested = Number.parseInt(count, 10);
    if (!Number.isFinite(requested) || requested <= 0) {
      throw new Error('Number of bots must be a positive whole number.');
    }

    if (requested > 24) {
      throw new Error('No more than 24 bots can be added at once.');
    }

    if (this.round.started || this.pendingOutcome) {
      throw new Error('Bots can only be added while waiting for the next round.');
    }

    const created = [];
    for (let index = 0; index < requested; index += 1) {
      const name = this.generateBotName();
      const bot = this.registerPlayer({ name, role: ROLES.PLAYER, isBot: true });
      created.push(bot);
    }

    return created;
  }

  resolveRound(participants) {
    const stageMap = new Map();

    participants.forEach((player) => {
      const stage =
        typeof player.layer === 'number' && Number.isFinite(player.layer)
          ? player.layer
          : 0;

      if (!stageMap.has(stage)) {
        stageMap.set(stage, []);
      }

      stageMap.get(stage).push(player);
    });

    const orderedStages = Array.from(stageMap.keys()).sort((a, b) => b - a);
    const stageMessages = [];
    const winningMoves = new Set();
    const eliminatedPlayerIds = [];
    const winnerPlayerIds = [];

    orderedStages.forEach((stage) => {
      const result = this.resolveStage(stage, stageMap.get(stage));

      if (!result) {
        return;
      }

      (result.winningMoves || []).forEach((move) => winningMoves.add(move));

      if (Array.isArray(result.eliminatedPlayerIds)) {
        eliminatedPlayerIds.push(...result.eliminatedPlayerIds);
      }

      if (Array.isArray(result.winnerPlayerIds)) {
        winnerPlayerIds.push(...result.winnerPlayerIds);
      }

      if (result.message) {
        stageMessages.push(result.message);
      }
    });

    let status = 'completed';
    if (winnerPlayerIds.length === 0 && eliminatedPlayerIds.length === 0) {
      status = 'tie';
    }

    const message =
      stageMessages.join(' ') ||
      (status === 'tie'
        ? 'Every stage ended in a stalemate. Positions remain unchanged.'
        : 'Stage battles resolved with updated standings.');

    return {
      status,
      message,
      winningMoves: Array.from(winningMoves),
      eliminatedPlayerIds,
      winnerPlayerIds
    };
  }

  resolveStage(stage, players) {
    if (!Array.isArray(players) || players.length === 0) {
      return {
        status: 'idle',
        message: '',
        winningMoves: [],
        eliminatedPlayerIds: [],
        winnerPlayerIds: []
      };
    }

    const stageLabel = `Stage ${stage}`;

    if (players.length === 1) {
      const [solo] = players;
      const targetStage = stage >= 0 ? stage : stage + 1;
      const message =
        stage >= 0
          ? `${stageLabel}: ${solo.name} holds position awaiting challengers.`
          : `${stageLabel}: ${solo.name} advances to stage ${targetStage} by default.`;

      return {
        status: 'default',
        message,
        winningMoves: solo.move ? [solo.move] : [],
        eliminatedPlayerIds: [],
        winnerPlayerIds: [solo.id]
      };
    }

    const movesChosen = new Set(players.map((player) => player.move));

    if (movesChosen.size === 1) {
      const [move] = movesChosen;
      return {
        status: 'tie',
        message: `${stageLabel}: Everyone played ${move}. No one changes stage.`,
        winningMoves: [],
        eliminatedPlayerIds: [],
        winnerPlayerIds: []
      };
    }

    if (movesChosen.size === 3) {
      return {
        status: 'tie',
        message: `${stageLabel}: All moves appeared. No one changes stage.`,
        winningMoves: [],
        eliminatedPlayerIds: [],
        winnerPlayerIds: []
      };
    }

    const [moveA, moveB] = Array.from(movesChosen);
    const winningMove = BEATS[moveA] === moveB ? moveA : moveB;
    const losingMove = winningMove === moveA ? moveB : moveA;

    const eliminated = players
      .filter((player) => player.move === losingMove)
      .map((player) => player.id);
    const winners = players
      .filter((player) => player.move === winningMove)
      .map((player) => player.id);

    const winnersTargetStage = stage >= 0 ? stage : stage + 1;
    const losersTargetStage = stage - 1;
    const movementMessage =
      stage >= 0
        ? `Winners hold at stage ${winnersTargetStage}, losers fall to stage ${losersTargetStage}.`
        : `Winners climb to stage ${winnersTargetStage}, losers fall to stage ${losersTargetStage}.`;

    return {
      status: 'completed',
      message: `${stageLabel}: ${winningMove} beats ${losingMove}. ${movementMessage}`,
      winningMoves: [winningMove],
      eliminatedPlayerIds: eliminated,
      winnerPlayerIds: winners
    };
  }

  applyInactivePenalty(inactivePlayers) {
    if (!inactivePlayers.length) {
      return [];
    }
    return inactivePlayers.map((player) => player.id);
  }

  applyOutcomeToPlayers(outcome) {
    if (!outcome || typeof outcome !== 'object') {
      return;
    }

    const processed = new Set();

    (outcome.winnerPlayerIds || []).forEach((id) => {
      const player = this.players.get(id);
      if (player) {
        player.markWinner();
        processed.add(id);
      }
    });

    (outcome.eliminatedPlayerIds || []).forEach((id) => {
      if (processed.has(id)) {
        return;
      }
      const player = this.players.get(id);
      if (player) {
        player.eliminate();
        processed.add(id);
      }
    });

    (outcome.inactivePlayerIds || []).forEach((id) => {
      if (processed.has(id)) {
        return;
      }
      const player = this.players.get(id);
      if (player) {
        player.markInactive();
        processed.add(id);
      }
    });
  }

  beginCompetitionPhase() {
    if (!this.pendingOutcome) {
      return null;
    }
    const phaseEndsAt = new Date(Date.now() + this.competitionStageMs).toISOString();
    this.round.phase = 'competing';
    this.round.phaseEndsAt = phaseEndsAt;
    return phaseEndsAt;
  }

  getProcessStageDuration() {
    return this.processStageMs;
  }

  getCompetitionStageDuration() {
    return this.competitionStageMs;
  }

  completePendingRound() {
    if (!this.pendingOutcome) {
      return null;
    }

    const { outcome, triggeredBy, options } = this.pendingOutcome;
    this.pendingOutcome = null;
    return this.finalizeRound(outcome, triggeredBy, options);
  }

  finalizeRound(outcome, triggeredBy, { roundExecuted, startedAt } = {}) {
    const nowIso = new Date().toISOString();
    const effectiveStartedAt = roundExecuted ? startedAt || nowIso : null;

    if (roundExecuted) {
      this.applyOutcomeToPlayers(outcome);
    }

    const fullOutcome = {
      ...outcome,
      roundNumber: this.round.number,
      triggeredBy,
      startedAt: effectiveStartedAt,
      completedAt: nowIso
    };

    this.round.started = roundExecuted;
    this.round.completed = true;
    this.round.startedAt = effectiveStartedAt;
    this.round.completedAt = nowIso;
    this.round.outcome = fullOutcome;
    this.round.phase = 'results';
    this.round.phaseEndsAt = null;
    this.lastOutcome = fullOutcome;

    this.roundHistory.push({
      number: this.round.number,
      started: roundExecuted,
      startedAt: effectiveStartedAt,
      completedAt: nowIso,
      outcome: fullOutcome
    });

    const nextNumber = this.round.number + 1;
    this.round = this.createRoundState(nextNumber);
    this.pendingOutcome = null;

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
    this.pendingOutcome = null;
    this.botCounter = 1;
  }
}

module.exports = GameState;
