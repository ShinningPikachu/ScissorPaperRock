const { v4: uuidv4 } = require('uuid');
const Player = require('./player');
const {
  MOVES,
  BEATS,
  ROLES,
  ROUND_INTERVAL_MS,
  PROCESS_STAGE_DURATION_MS,
  COMPETITION_STAGE_DURATION_MS,
  DUEL_STAGE_DURATION_MS,
  MIN_STAGE,
  MAX_STAGE
} = require('./constants');

class GameState {
  constructor({
    roundIntervalMs = ROUND_INTERVAL_MS,
    processStageMs = PROCESS_STAGE_DURATION_MS,
    competitionStageMs = COMPETITION_STAGE_DURATION_MS,
    duelStageMs = DUEL_STAGE_DURATION_MS
  } = {}) {
    this.roundIntervalMs = roundIntervalMs;
    this.processStageMs = processStageMs;
    this.competitionStageMs = competitionStageMs;
    this.duelStageMs = duelStageMs;
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
      phaseEndsAt: null,
      matchups: [],
      currentMatchupIndex: null
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

  registerPlayer({ name, role, isBot = false, botStrategy = 'random' }) {
    const trimmedName = (name || '').trim();
    if (!trimmedName) {
      throw new Error('Player name is required.');
    }

    if (role === ROLES.ADMIN && this.hasAdmin()) {
      throw new Error('An admin is already registered for this game.');
    }

    const id = uuidv4();
    const player = new Player({
      id,
      name: trimmedName,
      role,
      isBot,
      botStrategy: this.normalizeBotStrategy(botStrategy)
    });
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
    if (!player.isActivePlayer()) {
      throw new Error('Eliminated players cannot submit a move.');
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

    const { outcome, matchups } = this.resolveRound(readyPlayers);
    const inactivePenalty = penalizeInactive
      ? this.applyInactivePenalty(inactivePlayers)
      : [];
    outcome.inactivePlayerIds = inactivePenalty;

    const startedAt = new Date().toISOString();
    this.round.started = true;
    this.round.completed = false;
    this.round.startedAt = startedAt;
    this.round.matchups = matchups;
    if (matchups.length > 0 && this.duelStageMs > 0) {
      this.advanceDuelMatchup(0);
    } else {
      this.round.currentMatchupIndex = matchups.length > 0 ? 0 : null;
      if (this.processStageMs > 0) {
        this.round.phase = 'processing';
        this.round.phaseEndsAt = new Date(Date.now() + this.processStageMs).toISOString();
      } else {
        this.round.phase = 'processing';
        this.round.phaseEndsAt = null;
      }
    }
    this.round.outcome = null;
    this.setNextRoundAt(null);

    this.pendingOutcome = {
      outcome,
      triggeredBy,
      options: { roundExecuted: true, startedAt }
    };

    if (this.duelStageMs <= 0 && this.processStageMs <= 0 && this.competitionStageMs <= 0) {
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
        startedAt,
        matchups
      }
    };
  }

  getParticipants() {
    return Array.from(this.players.values()).filter(
      (player) => player.role === ROLES.PLAYER && player.isActivePlayer()
    );
  }

  assignBotMoves() {
    const moveOptions = Object.values(MOVES);
    if (!moveOptions.length) {
      return;
    }

    for (const player of this.players.values()) {
      if (player.role !== ROLES.PLAYER || !player.isBot) {
        continue;
      }

      if (!player.isActivePlayer()) {
        continue;
      }

      const strategy = player.botStrategy || 'random';
      let nextMove;

      if (strategy === 'random') {
        nextMove = moveOptions[Math.floor(Math.random() * moveOptions.length)];
      } else {
        nextMove = strategy;
      }

      player.setMove(nextMove);
    }
  }

  generateBotName() {
    const padded = this.botCounter.toString().padStart(2, '0');
    this.botCounter += 1;
    return this.ensureUniqueBotName(`Bot ${padded}`);
  }

  isNameTaken(name) {
    return Array.from(this.players.values()).some((player) => player.name === name);
  }

  ensureUniqueBotName(baseName) {
    const fallback =
      typeof baseName === 'string' && baseName.trim().length > 0
        ? baseName.trim()
        : `Bot ${this.botCounter.toString().padStart(2, '0')}`;

    let candidate = fallback;
    let suffix = 2;

    while (this.isNameTaken(candidate)) {
      candidate = `${fallback} (${suffix})`;
      suffix += 1;
    }

    return candidate;
  }

  normalizeBotStrategy(strategy) {
    const value = typeof strategy === 'string' ? strategy.toLowerCase() : 'random';
    if (value === 'random') {
      return 'random';
    }
    if (Object.values(MOVES).includes(value)) {
      return value;
    }
    return 'random';
  }

  getActivePlayerCount() {
    return this.getParticipants().length;
  }

  advanceDuelMatchup(index) {
    const matchups = Array.isArray(this.round.matchups) ? this.round.matchups : [];
    if (matchups.length === 0) {
      this.round.currentMatchupIndex = null;
      this.round.phase = 'processing';
      this.round.phaseEndsAt =
        this.processStageMs > 0
          ? new Date(Date.now() + this.processStageMs).toISOString()
          : null;
      return null;
    }

    const boundedIndex = Math.max(0, Math.min(index, matchups.length - 1));
    this.round.phase = 'duel';
    this.round.currentMatchupIndex = boundedIndex;
    if (this.duelStageMs > 0) {
      this.round.phaseEndsAt = new Date(Date.now() + this.duelStageMs).toISOString();
    } else {
      this.round.phaseEndsAt = null;
    }
    return matchups[boundedIndex];
  }

  getDuelStageDuration() {
    return this.duelStageMs;
  }

  addBots({ count, names, strategy } = {}) {
    if (this.round.started || this.pendingOutcome) {
      throw new Error('Bots can only be added while waiting for the next round.');
    }

    const normalizedStrategy = this.normalizeBotStrategy(strategy);

    const providedNames = Array.isArray(names)
      ? names
          .map((value) => (typeof value === 'string' ? value.trim() : ''))
          .filter((value) => value.length > 0)
      : [];

    let requested = 0;
    if (providedNames.length > 0) {
      requested = providedNames.length;
    } else {
      requested = Number.parseInt(count, 10);
    }

    if (!Number.isFinite(requested) || requested <= 0) {
      throw new Error('Number of bots must be a positive whole number.');
    }

    if (requested > 24) {
      throw new Error('No more than 24 bots can be added at once.');
    }

    const created = [];

    if (providedNames.length > 0) {
      providedNames.forEach((name) => {
        const uniqueName = this.ensureUniqueBotName(name);
        const bot = this.registerPlayer({
          name: uniqueName,
          role: ROLES.PLAYER,
          isBot: true,
          botStrategy: normalizedStrategy
        });
        created.push(bot);
      });
      return created;
    }

    for (let index = 0; index < requested; index += 1) {
      const name = this.generateBotName();
      const bot = this.registerPlayer({
        name,
        role: ROLES.PLAYER,
        isBot: true,
        botStrategy: normalizedStrategy
      });
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
    const eliminatedPlayerIds = new Set();
    const winnerPlayerIds = new Set();
    const matchups = [];

    const compareMoves = (playerA, playerB) => {
      const moveA = playerA.move;
      const moveB = playerB.move;

      if (moveA === moveB) {
        return { result: 'tie', winner: null, loser: null };
      }

      if (BEATS[moveA] === moveB) {
        return { result: 'a', winner: playerA, loser: playerB };
      }

      return { result: 'b', winner: playerB, loser: playerA };
    };

    orderedStages.forEach((stage) => {
      const players = [...stageMap.get(stage)];
      if (players.length === 0) {
        return;
      }

      for (let index = players.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        [players[index], players[swapIndex]] = [players[swapIndex], players[index]];
      }

      const stageLabel = `Stage ${stage}`;

      for (let idx = 0; idx < players.length; idx += 2) {
        const fighterA = players[idx];
        const fighterB = players[idx + 1] || null;
        const matchup = {
          id: `duel-${this.round.number}-${stage}-${Math.floor(idx / 2) + 1}`,
          stage,
          aId: fighterA.id,
          aName: fighterA.name,
          bId: fighterB ? fighterB.id : null,
          bName: fighterB ? fighterB.name : null,
          result: 'pending'
        };

        if (!fighterB) {
          matchup.result = 'bye';
          matchups.push(matchup);
          stageMessages.push(`${stageLabel}: ${fighterA.name} advances with a bye.`);
          continue;
        }

        const outcome = compareMoves(fighterA, fighterB);

        if (outcome.result === 'tie') {
          matchup.result = 'tie';
          matchups.push(matchup);
          stageMessages.push(
            `${stageLabel}: ${fighterA.name} and ${fighterB.name} tied with ${fighterA.move}.`
          );
          continue;
        }

        const winner = outcome.winner;
        const loser = outcome.loser;
        winningMoves.add(winner.move);
        winnerPlayerIds.add(winner.id);
        eliminatedPlayerIds.add(loser.id);
        matchup.result = winner.id === fighterA.id ? 'a' : 'b';
        matchups.push(matchup);

        stageMessages.push(
          `${stageLabel}: ${winner.name}'s ${winner.move} beats ${loser.name}'s ${loser.move}.`
        );
      }
    });

    const status =
      winnerPlayerIds.size === 0 && eliminatedPlayerIds.size === 0 ? 'tie' : 'completed';

    const message =
      stageMessages.join(' ') ||
      (status === 'tie'
        ? 'Every duel ended in a stalemate. Positions remain unchanged.'
        : 'Duels resolved with updated standings.');

    return {
      outcome: {
        status,
        message,
        winningMoves: Array.from(winningMoves),
        eliminatedPlayerIds: Array.from(eliminatedPlayerIds),
        winnerPlayerIds: Array.from(winnerPlayerIds)
      },
      matchups
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

  beginProcessingPhase() {
    if (!this.pendingOutcome) {
      return null;
    }
    const phaseEndsAt = new Date(Date.now() + this.processStageMs).toISOString();
    this.round.phase = 'processing';
    this.round.phaseEndsAt = phaseEndsAt;
    this.round.currentMatchupIndex = null;
    return phaseEndsAt;
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

    this.applyOutcomeToPlayers(outcome);

    const fullOutcome = {
      ...outcome,
      roundNumber: this.round.number,
      triggeredBy,
      startedAt: effectiveStartedAt,
      completedAt: nowIso,
      matchups: Array.isArray(this.round.matchups) ? this.round.matchups : []
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
      outcome: fullOutcome,
      matchups: fullOutcome.matchups
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
