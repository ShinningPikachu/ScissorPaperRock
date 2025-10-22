const { PLAYER_STATUS, ROLES, MIN_STAGE, MAX_STAGE } = require('./constants');

class Player {
  constructor({ id, name, role, isBot = false }) {
    this.id = id;
    this.name = name;
    this.role = role === ROLES.ADMIN ? ROLES.ADMIN : ROLES.PLAYER;
    this.isBot = Boolean(isBot);
    if (this.isBot && this.role !== ROLES.ADMIN) {
      this.role = ROLES.PLAYER;
    }
    this.move = null;
    this.stageStrategies = {};
    this.status = PLAYER_STATUS.WAITING;
    this.joinedAt = new Date().toISOString();
    this.layer = 0;
    this.lastMoveAt = null;
  }

  setMove(move, stage = this.layer) {
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
      this.layer = Math.max(this.layer - 1, MIN_STAGE);
      this.updateMoveForCurrentStage();
    }
    this.status = PLAYER_STATUS.ELIMINATED;
  }

  markWinner() {
    if (this.role === ROLES.PLAYER) {
      if (this.layer > MAX_STAGE) {
        this.layer = Math.max(this.layer - 1, MIN_STAGE);
      } else if (this.layer < MAX_STAGE) {
        this.layer = Math.min(MAX_STAGE, this.layer + 1);
      }
      this.updateMoveForCurrentStage();
    }
    this.status = PLAYER_STATUS.WINNER;
  }

  markInactive() {
    if (this.role === ROLES.PLAYER) {
      this.layer = Math.max(this.layer - 1, MIN_STAGE);
      this.updateMoveForCurrentStage();
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
