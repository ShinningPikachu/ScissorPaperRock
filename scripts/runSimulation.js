const GameState = require('../src/game/gameState');
const { MOVES, ROLES } = require('../src/game/constants');

const TOTAL_PLAYERS = 20;
const ROUNDS_TO_PLAY = 5;
const ROUND_MOVE_SETS = [
  [MOVES.ROCK, MOVES.SCISSORS],
  [MOVES.SCISSORS, MOVES.PAPER],
  [MOVES.PAPER, MOVES.ROCK]
];

const game = new GameState({
  roundIntervalMs: 0,
  processStageMs: 0,
  competitionStageMs: 0,
  duelStageMs: 0
});
const admin = game.registerPlayer({ name: 'Sim Admin', role: ROLES.ADMIN });
const players = [];

for (let index = 1; index <= TOTAL_PLAYERS; index += 1) {
  const player = game.registerPlayer({
    name: `Player-${index.toString().padStart(2, '0')}`,
    role: ROLES.PLAYER
  });
  players.push(player);
}

console.log(`Registered ${players.length} simulated players plus admin ${admin.name}.`);

for (let round = 1; round <= ROUNDS_TO_PLAY; round += 1) {
  const activeBeforeRound =
    typeof game.getActivePlayerCount === 'function'
      ? game.getActivePlayerCount()
      : players.length;

  if (activeBeforeRound <= 1) {
    console.log('\nOnly one active player remains. Ending simulation early.');
    break;
  }

  console.log(`\n--- Round ${round} ---`);

  const [primaryMove, secondaryMove] =
    ROUND_MOVE_SETS[(round - 1) % ROUND_MOVE_SETS.length];

  players.forEach((playerMeta, idx) => {
    const playerEntity = game.getPlayer(playerMeta.id);

     if (typeof playerEntity.isActivePlayer === 'function' && !playerEntity.isActivePlayer()) {
      return;
    }

    const shouldSkipThisRound = round % 2 === 1 && idx % 6 === 0;

    if (shouldSkipThisRound) {
      playerEntity.setMove(null);
      return;
    }

    const move = idx % 2 === 0 ? primaryMove : secondaryMove;
    game.setPlayerMove(playerMeta.id, move);
  });

  const { outcome } = game.startRound({
    triggeredBy: 'simulation',
    skipAdminValidation: true,
    requireAllReady: false
  });

  console.log('Outcome:', {
    status: outcome.status,
    message: outcome.message,
    roundNumber: outcome.roundNumber,
    winners: outcome.winnerPlayerIds?.length || 0,
    losers: outcome.eliminatedPlayerIds?.length || 0,
    inactive: outcome.inactivePlayerIds?.length || 0
  });

  const snapshot = game.getPublicState();
  const tableData = snapshot.players
    .filter((player) => player.role === ROLES.PLAYER)
    .map((player) => ({
      Name: player.name,
      Move: player.move,
      Status: player.status,
      Stage: player.layer,
      Active: player.active !== false
    }));

  console.table(tableData);
}

console.log('\nSimulation complete.');
