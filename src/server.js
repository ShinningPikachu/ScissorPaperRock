const path = require('path');
const express = require('express');
const GameState = require('./game/gameState');
const { MOVES, ROLES, ROUND_INTERVAL_MS } = require('./game/constants');

const app = express();
const gameState = new GameState({ roundIntervalMs: ROUND_INTERVAL_MS });
let autoRoundTimeout = null;

const queueNextAutoRound = (delayMs = ROUND_INTERVAL_MS) => {
  if (autoRoundTimeout) {
    clearTimeout(autoRoundTimeout);
    autoRoundTimeout = null;
  }
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
    const outcome = gameState.startRound({
      triggeredBy: 'auto',
      skipAdminValidation: true,
      requireAllReady: false
    });

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
  } catch (error) {
    /* eslint-disable no-console */
    console.error('Auto round failed:', error.message);
    /* eslint-enable no-console */
  } finally {
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
    const { move } = req.body || {};
    const player = gameState.setPlayerMove(playerId, move);
    res.json({
      player,
      message: `Move locked in as ${player.move}.`
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/game/start', (req, res, next) => {
  try {
    const { adminId } = req.body || {};
    const outcome = gameState.startRound({
      adminId,
      triggeredBy: 'manual',
      requireAllReady: true
    });
    queueNextAutoRound();
    res.json({
      outcome,
      state: gameState.getPublicState()
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/game/reset', (req, res, next) => {
  try {
    gameState.resetGame();
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
