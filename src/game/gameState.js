const { v4: uuidv4 } = require('uuid');
const Player = require('./player');
const {
  MOVES,
  BEATS,
  PLAYER_STATUS,
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
      if (matchups.length > 0) {
        this.revealAllMatchups();
      }
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
      const nextMove = this.getMoveForStrategy(strategy, moveOptions);

      if (nextMove) {
        player.setMove(nextMove);
      }
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

  getMoveForStrategy(strategy, moveOptions = Object.values(MOVES)) {
    const options = Array.isArray(moveOptions) ? moveOptions.filter(Boolean) : [];
    if (options.length === 0) {
      return null;
    }
    const value = typeof strategy === 'string' ? strategy.toLowerCase() : 'random';
    if (value === 'random') {
      return options[Math.floor(Math.random() * options.length)];
    }
    if (options.includes(value)) {
      return value;
    }
    return options[Math.floor(Math.random() * options.length)];
  }

  applyInitialBotStrategy(player) {
    if (!player || player.role !== ROLES.PLAYER || !player.isBot) {
      return;
    }
    const initialMove = this.getMoveForStrategy(player.botStrategy);
    if (initialMove) {
      player.setMove(initialMove);
    }
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

  setMatchupResolution(matchup, resolution) {
    if (!matchup || typeof matchup !== 'object') {
      return;
    }
    if (
      !resolution ||
      typeof resolution !== 'object' ||
      !Object.keys(resolution).length
    ) {
      if (Object.prototype.hasOwnProperty.call(matchup, '_resolution')) {
        delete matchup._resolution;
      }
      return;
    }
    if (Object.prototype.hasOwnProperty.call(matchup, '_resolution')) {
      matchup._resolution = resolution;
      return;
    }
    Object.defineProperty(matchup, '_resolution', {
      value: resolution,
      enumerable: false,
      configurable: true,
      writable: true
    });
  }

  revealDuelMatchup(index) {
    const matchups = Array.isArray(this.round.matchups) ? this.round.matchups : [];
    if (matchups.length === 0) {
      return null;
    }

    const boundedIndex = Math.max(0, Math.min(index, matchups.length - 1));
    const matchup = matchups[boundedIndex];

    if (!matchup || matchup.revealed) {
      return matchup || null;
    }

    const resolution = matchup._resolution;
    matchup.winnerIds = [];
    if (resolution && typeof resolution === 'object') {
      matchup.result = resolution.result || 'pending';
      matchup.winnerId =
        typeof resolution.winnerId === 'string' ? resolution.winnerId : null;
      matchup.loserId = typeof resolution.loserId === 'string' ? resolution.loserId : null;
      matchup.winnerMove =
        typeof resolution.winnerMove === 'string' ? resolution.winnerMove : null;
      matchup.loserMove =
        typeof resolution.loserMove === 'string' ? resolution.loserMove : null;
      matchup.loserNextLayer =
        typeof resolution.loserNextLayer === 'number' && Number.isFinite(resolution.loserNextLayer)
          ? resolution.loserNextLayer
          : null;
      const winnerIdsValue = Array.isArray(resolution.winnerIds)
        ? resolution.winnerIds.filter((value) => typeof value === 'string' && value.length > 0)
        : [];
      if (winnerIdsValue.length > 0) {
        matchup.winnerIds = winnerIdsValue;
        if (!matchup.winnerId && winnerIdsValue.length === 1) {
          [matchup.winnerId] = winnerIdsValue;
        }
      }
    }

    matchup.revealed = true;
    if (Object.prototype.hasOwnProperty.call(matchup, '_resolution')) {
      delete matchup._resolution;
    }

    return matchup;
  }

  revealAllMatchups() {
    const matchups = Array.isArray(this.round.matchups) ? this.round.matchups : [];
    matchups.forEach((_, idx) => {
      this.revealDuelMatchup(idx);
    });
    return matchups;
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
        const registration = this.registerPlayer({
          name: uniqueName,
          role: ROLES.PLAYER,
          isBot: true,
          botStrategy: normalizedStrategy
        });
        const botPlayer = this.getPlayer(registration.id);
        this.applyInitialBotStrategy(botPlayer);
        created.push(botPlayer.serialize());
      });
      return created;
    }

    for (let index = 0; index < requested; index += 1) {
      const name = this.generateBotName();
      const registration = this.registerPlayer({
        name,
        role: ROLES.PLAYER,
        isBot: true,
        botStrategy: normalizedStrategy
      });
      const botPlayer = this.getPlayer(registration.id);
      this.applyInitialBotStrategy(botPlayer);
      created.push(botPlayer.serialize());
    }

    return created;
  }

  resolveRound(participants) {
    const stageBuckets = new Map();
    const playerStages = new Map();

    participants.forEach((player) => {
      const startingStage = 0;
      playerStages.set(player.id, startingStage);

      if (!stageBuckets.has(startingStage)) {
        stageBuckets.set(startingStage, []);
      }

      stageBuckets.get(startingStage).push(player);
    });

    const initialStages = Array.from(stageBuckets.keys()).sort((a, b) => b - a);
    const pendingStages = [...initialStages];
    const enqueuedStages = new Set(pendingStages);
    const stageMessages = [];
    const winningMoves = new Set();
    const winnerPlayerIds = new Set();
    const eliminatedPlayerIds = new Set();
    const eliminationEvents = [];
    const demotionCounts = new Map();
    const matchups = [];

    const compareMoves = (playerA, playerB) => {
      const moveA = playerA.move;
      const moveB = playerB.move;

      if (moveA === moveB) {
        const roll = Math.random();
        if (roll < 1 / 3) {
          return { result: 'a', winner: playerA, loser: playerB };
        }
        if (roll < 2 / 3) {
          return { result: 'b', winner: playerB, loser: playerA };
        }
        return { result: 'both', winners: [playerA, playerB] };
      }

      if (BEATS[moveA] === moveB) {
        return { result: 'a', winner: playerA, loser: playerB };
      }

      return { result: 'b', winner: playerB, loser: playerA };
    };

    while (pendingStages.length > 0) {
      pendingStages.sort((a, b) => b - a);
      const stage = pendingStages.shift();
      enqueuedStages.delete(stage);

      const playersAtStage = stageBuckets.get(stage) || [];
      if (playersAtStage.length === 0) {
        continue;
      }

      for (let index = playersAtStage.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        [playersAtStage[index], playersAtStage[swapIndex]] = [
          playersAtStage[swapIndex],
          playersAtStage[index]
        ];
      }

      const stageLabel = `Layer ${stage}`;
      const stageLosers = [];
      let duelNumber = 0;

      for (let idx = 0; idx < playersAtStage.length; idx += 2) {
        const fighterA = playersAtStage[idx];
        const fighterB = playersAtStage[idx + 1] || null;
        duelNumber += 1;
        const matchup = {
          id: `duel-${this.round.number}-${stage}-${duelNumber}`,
          stage,
          aId: fighterA.id,
          aName: fighterA.name,
          bId: fighterB ? fighterB.id : null,
          bName: fighterB ? fighterB.name : null,
          result: 'pending',
          winnerId: null,
          winnerIds: [],
          loserId: null,
          winnerMove: null,
          loserMove: null,
          loserNextLayer: null,
          revealed: false
        };

        if (!fighterB) {
          this.setMatchupResolution(matchup, {
            result: 'bye',
            winnerId: fighterA.id,
            winnerIds: [fighterA.id],
            loserId: null,
            winnerMove: fighterA.move || null,
            loserMove: null,
            loserNextLayer: null
          });
          matchups.push(matchup);
          if (fighterA.move) {
            winningMoves.add(fighterA.move);
          }
          winnerPlayerIds.add(fighterA.id);
          stageMessages.push(`${stageLabel}: ${fighterA.name} advances with a bye.`);
          continue;
        }

        const duelOutcome = compareMoves(fighterA, fighterB);
        if (duelOutcome.result === 'both') {
          const sharedMove = fighterA.move || fighterB.move || null;
          const moveDescription = sharedMove
            ? `both choosing ${sharedMove}`
            : 'matching strategies';
          this.setMatchupResolution(matchup, {
            result: 'double-win',
            winnerIds: [fighterA.id, fighterB.id],
            winnerMove: sharedMove,
            loserMove: sharedMove,
            loserId: null,
            loserNextLayer: null
          });
          matchups.push(matchup);
          if (sharedMove) {
            winningMoves.add(sharedMove);
          }
          winnerPlayerIds.add(fighterA.id);
          winnerPlayerIds.add(fighterB.id);
          stageMessages.push(
            `${stageLabel}: ${fighterA.name} and ${fighterB.name} both advance despite ${moveDescription}.`
          );
          continue;
        }

        const winner = duelOutcome.winner;
        const loser = duelOutcome.loser;
        winningMoves.add(winner.move);
        winnerPlayerIds.add(winner.id);
        const loserCurrentLayer = playerStages.has(loser.id)
          ? playerStages.get(loser.id)
          : stage;
        const nextStage = stage - 1;
        const loserNextLayer = Math.max(loserCurrentLayer - 1, MIN_STAGE);
        playerStages.set(loser.id, nextStage);
        this.setMatchupResolution(matchup, {
          result: winner.id === fighterA.id ? 'a' : 'b',
          winnerId: winner.id,
          winnerIds: [winner.id],
          loserId: loser.id,
          winnerMove: winner.move || null,
          loserMove: loser.move || null,
          loserNextLayer
        });
        matchups.push(matchup);

        stageLosers.push(loser);
        const previousCount = demotionCounts.get(loser.id) || 0;
        demotionCounts.set(loser.id, previousCount + 1);

        stageMessages.push(
          `${stageLabel}: ${winner.name}'s ${winner.move} beats ${loser.name}'s ${loser.move}. ${loser.name} drops to layer ${loserNextLayer}.`
        );
      }

      if (stageLosers.length === 0) {
        continue;
      }

      const nextStage = stage - 1;
      if (stageLosers.length === 1) {
        const doomed = stageLosers[0];
        eliminatedPlayerIds.add(doomed.id);
        const eliminatedLayer = Math.max(nextStage, MIN_STAGE);
        eliminationEvents.push({
          playerId: doomed.id,
          playerName: doomed.name,
          eliminatedAt: eliminatedLayer,
          round: this.round.number
        });
        stageMessages.push(
          `Layer ${eliminatedLayer}: ${doomed.name} is the final player in the loser bracket and is eliminated from the arena.`
        );
        continue;
      }

      if (!stageBuckets.has(nextStage)) {
        stageBuckets.set(nextStage, []);
      }
      stageBuckets.get(nextStage).push(...stageLosers);

      if (!enqueuedStages.has(nextStage)) {
        pendingStages.push(nextStage);
        enqueuedStages.add(nextStage);
      }
    }

    const status =
      winnerPlayerIds.size === 0 && eliminatedPlayerIds.size === 0 ? 'tie' : 'completed';

    const message =
      status === 'tie'
        ? 'Every duel ended in a stalemate. Positions remain unchanged.'
        : 'Duels resolved with updated standings.';

    const demotedPlayerSteps = Array.from(demotionCounts.entries()).map(
      ([playerId, count]) => ({
        playerId,
        count
      })
    );
    const demotedPlayerIds = Array.from(demotionCounts.keys()).filter(
      (playerId) => !eliminatedPlayerIds.has(playerId)
    );

    return {
      outcome: {
        status,
        message,
        winningMoves: Array.from(winningMoves),
        eliminatedPlayerIds: Array.from(eliminatedPlayerIds),
        winnerPlayerIds: Array.from(winnerPlayerIds),
        demotedPlayerSteps,
        demotedPlayerIds,
        eliminationEvents,
        stageLog: stageMessages
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

    const eliminatedIdsSet = new Set(outcome.eliminatedPlayerIds || []);

    const demotions = Array.isArray(outcome.demotedPlayerSteps)
      ? outcome.demotedPlayerSteps
      : [];

    demotions.forEach(({ playerId, count }) => {
      const player = this.players.get(playerId);
      if (!player || !Number.isFinite(count) || count <= 0) {
        return;
      }
      for (let index = 0; index < count; index += 1) {
        player.demote();
      }
    });

    const processed = new Set();

    (outcome.winnerPlayerIds || []).forEach((id) => {
      const player = this.players.get(id);
      if (player) {
        player.markWinner();
        processed.add(id);
      }
    });

    eliminatedIdsSet.forEach((id) => {
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

    if (eliminatedIdsSet.size > 0) {
      this.players.forEach((player) => {
        if (player.role !== ROLES.PLAYER) {
          return;
        }
        if (eliminatedIdsSet.has(player.id)) {
          return;
        }
        if (player.status === PLAYER_STATUS.ELIMINATED) {
          return;
        }
        player.resetToBaseLayer();
      });
    }
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

    this.revealAllMatchups();
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

    if (this.roundIntervalMs > 0) {
      this.scheduleNextRound(this.roundIntervalMs);
    } else {
      this.setNextRoundAt(null);
    }

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
