const { PLAYER_STATUS, ROLES, MIN_STAGE, MOVES } = require('./constants');

const BOT_STRATEGIES = new Set([
  'random',
  MOVES.ROCK,
  MOVES.PAPER,
  MOVES.SCISSORS
]);

class Player {
  constructor({ id, name, role, isBot = false, botStrategy = 'random' }) {
    this.id = id;
    this.name = name;
    this.role = role === ROLES.ADMIN ? ROLES.ADMIN : ROLES.PLAYER;
    this.isBot = Boolean(isBot);
    if (this.isBot && this.role !== ROLES.ADMIN) {
      this.role = ROLES.PLAYER;
    }
    this.botStrategy = this.isBot ? this.normalizeStrategy(botStrategy) : null;
    this.isActive = true;
    this.move = null;
    this.stageStrategies = {};
    this.status = PLAYER_STATUS.WAITING;
    this.joinedAt = new Date().toISOString();
    this.layer = 0;
    this.lastMoveAt = null;
  }

  normalizeStrategy(strategy) {
    const value = typeof strategy === 'string' ? strategy.toLowerCase() : 'random';
    if (BOT_STRATEGIES.has(value)) {
      return value;
    }
    return 'random';
  }

  setBotStrategy(strategy) {
    if (!this.isBot) {
      this.botStrategy = null;
      return;
    }
    this.botStrategy = this.normalizeStrategy(strategy);
  }

  isActivePlayer() {
    return this.role === ROLES.PLAYER && this.isActive;
  }

  setMove(move, stage = this.layer) {
    if (this.role === ROLES.PLAYER && !this.isActive) {
      return;
    }

    const stageValue = Number.parseInt(stage, 10);
    if (!Number.isFinite(stageValue)) {
      return;
    }

    const normalizedMove = move || null;
    const stageKey = stageValue.toString();

    if (normalizedMove) {
      this.stageStrategies[stageKey] = normalizedMove;
    } else {
      delete this.stageStrategies[stageKey];
    }

    if (stageValue === this.layer) {
      this.move = normalizedMove;
      if (normalizedMove) {
        this.status = PLAYER_STATUS.READY;
        this.lastMoveAt = new Date().toISOString();
      } else {
        this.status = PLAYER_STATUS.WAITING;
      }
    }
  }

  eliminate() {
    if (this.role === ROLES.PLAYER) {
      this.move = null;
      this.lastMoveAt = null;
      this.isActive = false;
    }
    this.status = PLAYER_STATUS.ELIMINATED;
  }

  demote() {
    if (this.role !== ROLES.PLAYER) {
      return;
    }

    const nextLayer = Math.max(this.layer - 1, MIN_STAGE);
    this.layer = nextLayer;
    this.isActive = true;
    this.move = null;
    this.lastMoveAt = null;
    this.updateMoveForCurrentStage();
    this.status = this.move ? PLAYER_STATUS.READY : PLAYER_STATUS.WAITING;
  }

  resetToBaseLayer() {
    if (this.role !== ROLES.PLAYER) {
      return;
    }

    this.layer = 0;
    this.isActive = true;

    const strategy = this.stageStrategies['0'] || null;
    this.move = strategy;
    if (strategy) {
      this.status = PLAYER_STATUS.READY;
    } else {
      this.status = PLAYER_STATUS.WAITING;
      this.lastMoveAt = null;
    }
  }

  markWinner() {
    if (this.role === ROLES.PLAYER) {
      this.isActive = true;
      this.updateMoveForCurrentStage();
    }
    this.status = PLAYER_STATUS.WINNER;
  }

  markInactive() {
    if (this.role === ROLES.PLAYER) {
      this.demote();
    }
    this.status = PLAYER_STATUS.INACTIVE;
  }

  updateMoveForCurrentStage() {
    const stageKey = this.layer.toString();
    const strategy = this.stageStrategies[stageKey] || null;
    this.move = strategy;
    if (!strategy) {
      this.status = PLAYER_STATUS.WAITING;
    }
  }

  serialize() {
    return {
      id: this.id,
      name: this.name,
      role: this.role,
      isBot: this.isBot,
      botStrategy: this.isBot ? this.botStrategy : null,
      active: this.isActive,
      move: this.move,
      stageStrategies: { ...this.stageStrategies },
      status: this.status,
      joinedAt: this.joinedAt,
      layer: this.layer,
      lastMoveAt: this.lastMoveAt
    };
  }
}

module.exports = Player;
