const path = require('path');
const express = require('express');
const GameState = require('./game/gameState');
const { MOVES, ROLES, ROUND_INTERVAL_MS } = require('./game/constants');

const app = express();
const gameState = new GameState({ roundIntervalMs: ROUND_INTERVAL_MS });
let autoRoundTimeout = null;
let processingTimeout = null;
let competitionTimeout = null;

const clearAutoRoundTimer = () => {
  if (autoRoundTimeout) {
    clearTimeout(autoRoundTimeout);
    autoRoundTimeout = null;
  }
};

const clearLifecycleTimers = () => {
  if (processingTimeout) {
    clearTimeout(processingTimeout);
    processingTimeout = null;
  }
  if (competitionTimeout) {
    clearTimeout(competitionTimeout);
    competitionTimeout = null;
  }
};

const handleRoundCompletion = () => {
  const outcome = gameState.completePendingRound();

  if (outcome && outcome.triggeredBy === 'auto') {
    /* eslint-disable no-console */
    if (outcome.status !== 'skipped') {
      console.log(
        `Auto Round ${outcome.roundNumber}: ${outcome.message} (triggered=${outcome.triggeredBy})`
      );
    } else {
      console.log(
        `Auto Round ${outcome.roundNumber} skipped: ${outcome.message}`
      );
    }
    /* eslint-enable no-console */
  }

  queueNextAutoRound();
};

const scheduleRoundLifecycle = () => {
  clearLifecycleTimers();

  const processingDelay = gameState.getProcessStageDuration();
  const competitionDelay = gameState.getCompetitionStageDuration();

  processingTimeout = setTimeout(() => {
    processingTimeout = null;
    gameState.beginCompetitionPhase();

    competitionTimeout = setTimeout(() => {
      competitionTimeout = null;
      handleRoundCompletion();
    }, competitionDelay);
  }, processingDelay);
};

const queueNextAutoRound = (delayMs = ROUND_INTERVAL_MS) => {
  clearAutoRoundTimer();
  if (!delayMs) {
    return;
  }
  gameState.scheduleNextRound(delayMs);
  autoRoundTimeout = setTimeout(() => {
    runAutoRound();
  }, delayMs);
};

const runAutoRound = () => {
  try {
    const result = gameState.startRound({
      triggeredBy: 'auto',
      skipAdminValidation: true,
      requireAllReady: false
    });

    if (result.pending) {
      scheduleRoundLifecycle();
      return;
    }

    const outcome = result.outcome;
    if (outcome) {
      /* eslint-disable no-console */
      if (outcome.status !== 'skipped') {
        console.log(
          `Auto Round ${outcome.roundNumber}: ${outcome.message} (triggered=${outcome.triggeredBy})`
        );
      } else {
        console.log(
          `Auto Round ${outcome.roundNumber} skipped: ${outcome.message}`
        );
      }
      /* eslint-enable no-console */
    }

    queueNextAutoRound();
  } catch (error) {
    /* eslint-disable no-console */
    console.error('Auto round failed:', error.message);
    /* eslint-enable no-console */
    queueNextAutoRound();
  }
};

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

app.get('/api/state', (req, res) => {
  res.json({
    ...gameState.getPublicState(),
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
    const { adminId, count } = req.body || {};
    if (!adminId) {
      throw new Error('Admin ID is required to add bots.');
    }

    const admin = gameState.getPlayer(adminId);
    if (admin.role !== ROLES.ADMIN) {
      throw new Error('Only an admin can add bots.');
    }

    const bots = gameState.addBots(count);
    res.status(201).json({
      bots,
      message: `${bots.length} bot${bots.length === 1 ? '' : 's'} added to the lobby.`,
      state: gameState.getPublicState()
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
    if (result.pending) {
      clearAutoRoundTimer();
      scheduleRoundLifecycle();
    } else {
      queueNextAutoRound();
    }
    res.json({
      outcome: result.outcome,
      state: gameState.getPublicState()
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/game/reset', (req, res, next) => {
  try {
    gameState.resetGame();
    clearLifecycleTimers();
    clearAutoRoundTimer();
    queueNextAutoRound();
    res.json({
      message: 'Game reset. All players cleared.',
      state: gameState.getPublicState()
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
  queueNextAutoRound();
});
