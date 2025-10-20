const MOVES = {
  ROCK: 'rock',
  PAPER: 'paper',
  SCISSORS: 'scissors'
};

const MOVE_ORDER = [MOVES.ROCK, MOVES.PAPER, MOVES.SCISSORS];

const BEATS = {
  [MOVES.ROCK]: MOVES.SCISSORS,
  [MOVES.PAPER]: MOVES.ROCK,
  [MOVES.SCISSORS]: MOVES.PAPER
};

const PLAYER_STATUS = {
  WAITING: 'waiting',
  READY: 'ready',
  ELIMINATED: 'eliminated',
  WINNER: 'winner',
  INACTIVE: 'inactive'
};

const ROLES = {
  PLAYER: 'player',
  ADMIN: 'admin'
};

const ROUND_INTERVAL_MS = 30_000;

module.exports = {
  MOVES,
  MOVE_ORDER,
  BEATS,
  PLAYER_STATUS,
  ROLES,
  ROUND_INTERVAL_MS
};
