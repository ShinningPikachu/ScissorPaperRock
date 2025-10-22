const path = require('path');
const express = require('express');
const GameState = require('./game/gameState');
const { MOVES, ROLES, ROUND_INTERVAL_MS } = require('./game/constants');

const app = express();
const gameState = new GameState({ roundIntervalMs: ROUND_INTERVAL_MS });
let duelTimeout = null;
let processingTimeout = null;
let competitionTimeout = null;
let tournamentModeEnabled = false;
let autoContinueTimeout = null;

const buildStatePayload = () => ({
  ...gameState.getPublicState(),
  tournamentMode: tournamentModeEnabled
});

const clearAutoProgress = () => {
  if (autoContinueTimeout) {
    clearTimeout(autoContinueTimeout);
    autoContinueTimeout = null;
  }
};

const clearLifecycleTimers = () => {
  if (duelTimeout) {
    clearTimeout(duelTimeout);
    duelTimeout = null;
  }
  if (processingTimeout) {
    clearTimeout(processingTimeout);
    processingTimeout = null;
  }
  if (competitionTimeout) {
    clearTimeout(competitionTimeout);
    competitionTimeout = null;
  }
};

const stopTournament = () => {
  tournamentModeEnabled = false;
  clearAutoProgress();
  gameState.setNextRoundAt(null);
};

const scheduleTournamentRound = () => {
  clearAutoProgress();
  if (!tournamentModeEnabled) {
    return;
  }

  const activeCount = gameState.getActivePlayerCount();
  if (activeCount <= 1) {
    /* eslint-disable no-console */
    if (activeCount === 1) {
      console.log('Tournament concluded. A champion has been crowned.');
    } else {
      console.log('Tournament concluded. No active players remain.');
    }
    /* eslint-enable no-console */
    stopTournament();
    return;
  }

  gameState.scheduleNextRound(1_000);
  autoContinueTimeout = setTimeout(() => {
    autoContinueTimeout = null;
    runTournamentRound();
  }, 1_000);
};

const runTournamentRound = () => {
  try {
    const result = gameState.startRound({
      triggeredBy: 'tournament',
      skipAdminValidation: true,
      requireAllReady: false
    });

    if (result.pending) {
      scheduleRoundLifecycle();
    } else {
      scheduleTournamentRound();
    }
  } catch (error) {
    /* eslint-disable no-console */
    console.error('Tournament round failed:', error.message);
    /* eslint-enable no-console */
    stopTournament();
  }
};

const handleRoundCompletion = () => {
  const outcome = gameState.completePendingRound();

  if (outcome) {
    gameState.setNextRoundAt(null);
    if (tournamentModeEnabled) {
      scheduleTournamentRound();
    }
  }
};

const scheduleRoundLifecycle = () => {
  clearLifecycleTimers();

  const processingDelay = gameState.getProcessStageDuration();
  const competitionDelay = gameState.getCompetitionStageDuration();
  const duelDelay = gameState.getDuelStageDuration();

  const scheduleCompetitionPhase = () => {
    gameState.beginCompetitionPhase();
    const finalDelay = Math.max(competitionDelay, 0);
    competitionTimeout = setTimeout(() => {
      competitionTimeout = null;
      handleRoundCompletion();
    }, finalDelay);
  };

  const scheduleProcessingPhase = () => {
    gameState.beginProcessingPhase();
    if (processingDelay <= 0) {
      scheduleCompetitionPhase();
      return;
    }
    processingTimeout = setTimeout(() => {
      processingTimeout = null;
      scheduleCompetitionPhase();
    }, processingDelay);
  };

  const startDuelSequence = () => {
    const matchups = Array.isArray(gameState.round.matchups)
      ? gameState.round.matchups
      : [];

    if (matchups.length === 0 || duelDelay <= 0) {
      scheduleProcessingPhase();
      return;
    }

    const playDuel = (index) => {
      gameState.advanceDuelMatchup(index);

      duelTimeout = setTimeout(() => {
        duelTimeout = null;
        const nextIndex = index + 1;
        if (nextIndex < matchups.length) {
          playDuel(nextIndex);
        } else {
          scheduleProcessingPhase();
        }
      }, duelDelay);
    };

    playDuel(0);
  };

  if (duelDelay > 0) {
    startDuelSequence();
  } else {
    scheduleProcessingPhase();
  }
};

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

app.get('/api/state', (req, res) => {
  res.json({
    ...buildStatePayload(),
    availableMoves: Object.values(MOVES)
  });
});

app.post('/api/players', (req, res, next) => {
  try {
    const { name, role } = req.body || {};
    const player = gameState.registerPlayer({
      name,
      role: role === ROLES.ADMIN ? ROLES.ADMIN : ROLES.PLAYER
    });
    res.status(201).json({
      player,
      message:
        player.role === ROLES.ADMIN
          ? 'Admin registered. You can start the round when everyone is ready.'
          : 'Player registered. Choose your move when ready.'
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/players/:playerId/move', (req, res, next) => {
  try {
    const { playerId } = req.params;
    const { move, stage } = req.body || {};

    const stageOverride =
      stage === null || stage === undefined ? null : Number.parseInt(stage, 10);

    const player = gameState.setPlayerMove(playerId, move, stageOverride);

    const effectiveStage =
      Number.isFinite(stageOverride) ? stageOverride : player.layer;

    const stageKey = effectiveStage.toString();
    const stageMove = player.stageStrategies?.[stageKey] || null;

    let message;
    if (stageMove) {
      message = `Strategy for stage ${effectiveStage} set to ${stageMove}.`;
      if (effectiveStage === player.layer) {
        message = `Current stage strategy locked in as ${stageMove}.`;
      }
    } else {
      message = `Strategy for stage ${effectiveStage} cleared.`;
      if (effectiveStage === player.layer) {
        message = 'Current stage strategy cleared. Choose a move before the next round.';
      }
    }

    res.json({
      player,
      stage: effectiveStage,
      message
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/bots', (req, res, next) => {
  try {
    const { adminId, count, names, strategy } = req.body || {};
    if (!adminId) {
      throw new Error('Admin ID is required to add bots.');
    }

    const admin = gameState.getPlayer(adminId);
    if (admin.role !== ROLES.ADMIN) {
      throw new Error('Only an admin can add bots.');
    }

    let parsedNames = [];
    if (typeof names === 'string') {
      parsedNames = names
        .split(/[\r\n,]+/)
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
    } else if (Array.isArray(names)) {
      parsedNames = names
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter((value) => value.length > 0);
    }

    const bots = gameState.addBots({
      count,
      names: parsedNames,
      strategy
    });

    const strategyLabel =
      typeof strategy === 'string' && strategy.trim().length > 0
        ? strategy.trim().toLowerCase()
        : 'random';

    res.status(201).json({
      bots,
      message: `${bots.length} bot${bots.length === 1 ? '' : 's'} added to the lobby using ${strategyLabel} strategy.`,
      state: buildStatePayload()
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/game/start', (req, res, next) => {
  try {
    const { adminId } = req.body || {};
    const result = gameState.startRound({
      adminId,
      triggeredBy: 'manual',
      requireAllReady: true
    });
    tournamentModeEnabled = true;
    clearAutoProgress();
    if (result.pending) {
      scheduleRoundLifecycle();
    } else {
      scheduleTournamentRound();
    }
    res.json({
      outcome: result.outcome,
      state: buildStatePayload()
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/game/reset', (req, res, next) => {
  try {
    stopTournament();
    gameState.resetGame();
    clearLifecycleTimers();
    res.json({
      message: 'Game reset. All players cleared.',
      state: buildStatePayload()
    });
  } catch (error) {
    next(error);
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((error, req, res, next) => {
  const status = error.status || 400;
  res.status(status).json({
    error: error.message || 'Something went wrong.'
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  /* eslint-disable no-console */
  console.log(`Server listening on http://localhost:${port}`);
  /* eslint-enable no-console */
  gameState.setNextRoundAt(null);
});
