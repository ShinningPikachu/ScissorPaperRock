const { PLAYER_STATUS, ROLES } = require('./constants');

class Player {
  constructor({ id, name, role }) {
    this.id = id;
    this.name = name;
    this.role = role === ROLES.ADMIN ? ROLES.ADMIN : ROLES.PLAYER;
    this.move = null;
    this.status = PLAYER_STATUS.WAITING;
    this.joinedAt = new Date().toISOString();
    this.layer = 0;
    this.lastMoveAt = null;
  }

  setMove(move) {
    this.move = move;
    this.status = PLAYER_STATUS.READY;
    this.lastMoveAt = new Date().toISOString();
  }

  eliminate() {
    if (this.role === ROLES.PLAYER) {
      this.layer += 1;
    }
    this.status = PLAYER_STATUS.ELIMINATED;
  }

  markWinner() {
    this.status = PLAYER_STATUS.WINNER;
  }

  markInactive() {
    if (this.role === ROLES.PLAYER) {
      this.layer += 1;
    }
    this.status = PLAYER_STATUS.INACTIVE;
  }

  serialize() {
    return {
      id: this.id,
      name: this.name,
      role: this.role,
      move: this.move,
      status: this.status,
      joinedAt: this.joinedAt,
      layer: this.layer,
      lastMoveAt: this.lastMoveAt
    };
  }
}

module.exports = Player;
