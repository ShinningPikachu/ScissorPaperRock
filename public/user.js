const { api, showFeedback, capitalize, formatRoundMeta } = window.SPR;

const state = {
  player: null,
  players: [],
  round: null,
  availableMoves: [],
  lastOutcome: null,
  nextRoundStartsAt: null,
  roundIntervalMs: null
};

const elements = {
  registrationForm: document.getElementById('registration-form'),
  registrationFeedback: document.getElementById('registration-feedback'),
  nameInput: document.getElementById('player-name'),
  playerActions: document.getElementById('player-actions'),
  playerSummary: document.getElementById('player-summary'),
  playerStatus: document.getElementById('player-status'),
  moveButtons: document.querySelectorAll('#player-actions .move-grid button'),
  refreshButton: document.getElementById('refresh-button'),
  playersTableBody: document.getElementById('players-table-body'),
  roundOutcome: document.getElementById('round-outcome'),
  nextRoundTimer: document.getElementById('next-round-timer'),
  strategySummaryBody: document.getElementById('strategy-summary-body')
};

const STORAGE_KEY = 'spr-current-player';

function init() {
  restorePlayerFromSession();
  wireEventHandlers();
  refreshState();
  setInterval(refreshState, 4000);
  setInterval(updateCountdown, 1000);
}

function wireEventHandlers() {
  if (elements.registrationForm) {
    elements.registrationForm.addEventListener('submit', onRegister);
  }
  elements.moveButtons.forEach((button) => {
    button.addEventListener('click', () => onMoveSelected(button.dataset.move));
  });
  if (elements.refreshButton) {
    elements.refreshButton.addEventListener('click', refreshState);
  }
}

async function onRegister(event) {
  event.preventDefault();
  const formData = new FormData(elements.registrationForm);
  const name = (formData.get('player-name') || '').trim();

  if (!name) {
    showFeedback(elements.registrationFeedback, 'Please provide a name.', true);
    return;
  }

  try {
    const response = await api.request('/api/players', {
      method: 'POST',
      body: { name, role: 'player' }
    });
    state.player = response.player;
    persistPlayerToSession();
    showFeedback(elements.registrationFeedback, response.message, false);
    elements.registrationForm.reset();
    refreshState();
  } catch (error) {
    showFeedback(elements.registrationFeedback, error.message, true);
  }
}

async function onMoveSelected(move) {
  if (!state.player || state.player.role !== 'player') {
    return;
  }

  try {
    const response = await api.request(`/api/players/${state.player.id}/move`, {
      method: 'POST',
      body: { move }
    });
    state.player = response.player;
    persistPlayerToSession();
    highlightSelectedMove(move);
    showFeedback(elements.playerStatus, response.message, false);
    refreshState();
  } catch (error) {
    showFeedback(elements.playerStatus, error.message, true);
  }
}

async function refreshState() {
  try {
    const data = await api.request('/api/state');
    state.availableMoves = data.availableMoves || [];
    state.players = data.players || [];
    state.round = data.round || null;
    state.lastOutcome = data.lastOutcome || null;
    state.nextRoundStartsAt = data.nextRoundStartsAt || null;
    state.roundIntervalMs = data.roundIntervalMs || state.roundIntervalMs;
    syncCurrentPlayer();
    renderState();
    updateCountdown();
  } catch (error) {
    console.error('Failed to refresh state', error);
  }
}

function syncCurrentPlayer() {
  if (!state.player) {
    return;
  }

  const fromServer = state.players.find((p) => p.id === state.player.id);
  if (fromServer) {
    state.player = fromServer;
    persistPlayerToSession();
  } else {
    showFeedback(
      elements.registrationFeedback,
      'Your player record no longer exists. Please register again.',
      true
    );
    clearStoredPlayer();
    state.player = null;
  }
}

function renderState() {
  renderRoundOutcome();
  renderStrategySummary();
  renderPlayersTable();
  updatePersonalSections();
}

function renderStrategySummary() {
  if (!elements.strategySummaryBody) {
    return;
  }

  const summary = window.SPR.summarizeStrategiesByLayer(state.players);
  const { layers, totals } = summary;

  elements.strategySummaryBody.innerHTML = '';

  if (layers.length === 0) {
    const emptyRow = document.createElement('tr');
    const emptyCell = document.createElement('td');
    emptyCell.colSpan = 6;
    emptyCell.textContent = 'No registered players yet.';
    emptyRow.appendChild(emptyCell);
    elements.strategySummaryBody.appendChild(emptyRow);
  } else {
    layers.forEach(({ layer, counts }) => {
      const row = document.createElement('tr');
      row.appendChild(createCell(layer));
      row.appendChild(createCell(counts.rock));
      row.appendChild(createCell(counts.paper));
      row.appendChild(createCell(counts.scissors));
      row.appendChild(createCell(counts.undecided));
      row.appendChild(createCell(counts.total));
      elements.strategySummaryBody.appendChild(row);
    });
  }

  const totalsRow = document.createElement('tr');
  totalsRow.className = 'summary-row';
  totalsRow.appendChild(createCell('Total'));
  totalsRow.appendChild(createCell(totals.rock));
  totalsRow.appendChild(createCell(totals.paper));
  totalsRow.appendChild(createCell(totals.scissors));
  totalsRow.appendChild(createCell(totals.undecided));
  totalsRow.appendChild(createCell(totals.total));
  elements.strategySummaryBody.appendChild(totalsRow);
}

function renderPlayersTable() {
  if (!elements.playersTableBody) {
    return;
  }

  elements.playersTableBody.innerHTML = '';
  state.players.forEach((player) => {
    const row = document.createElement('tr');

    row.appendChild(createCell(player.name));
    row.appendChild(createCell(capitalize(player.role)));

    const layerValue =
      typeof player.layer === 'number' && Number.isFinite(player.layer)
        ? player.layer
        : 0;
    row.appendChild(createCell(layerValue));

    const statusCell = document.createElement('td');
    const statusBadge = document.createElement('span');
    statusBadge.className = `status-pill status-${player.status}`;
    statusBadge.textContent = capitalize(player.status);
    statusCell.appendChild(statusBadge);
    row.appendChild(statusCell);

    row.appendChild(createCell(player.move ? capitalize(player.move) : '-'));
    elements.playersTableBody.appendChild(row);
  });
}

function renderRoundOutcome() {
  if (!elements.roundOutcome) {
    return;
  }

  const outcome = state.lastOutcome;
  if (!outcome) {
    elements.roundOutcome.textContent = 'Waiting for the first round to complete.';
    return;
  }

  const message = outcome.message || 'Round resolved.';
  const roundLabel =
    typeof outcome.roundNumber === 'number'
      ? `Round ${outcome.roundNumber}:`
      : 'Round Result:';

  const details = [
    `<strong>${roundLabel}</strong> ${message}`,
    formatRoundMeta('Winners', resolveNames(outcome.winnerPlayerIds)),
    formatRoundMeta('Down a layer', resolveNames(outcome.eliminatedPlayerIds)),
    formatRoundMeta('Missed the round', resolveNames(outcome.inactivePlayerIds))
  ];

  elements.roundOutcome.innerHTML = details.filter(Boolean).join(' ');
}

function updatePersonalSections() {
  if (!elements.playerActions) {
    return;
  }

  const hasPlayer = Boolean(state.player);
  elements.playerActions.classList.toggle('hidden', !hasPlayer);

  if (!hasPlayer) {
    highlightSelectedMove(null);
    elements.playerStatus.textContent = '';
    elements.playerSummary.textContent = '';
    return;
  }

  const layerValue =
    typeof state.player.layer === 'number' && Number.isFinite(state.player.layer)
      ? state.player.layer
      : 0;

  elements.playerSummary.textContent = `Logged in as ${state.player.name} (Layer ${layerValue}).`;
  highlightSelectedMove(state.player.move);

  let message = '';
  let isError = false;
  switch (state.player.status) {
    case 'eliminated':
      message = `You lost the last round. You are now on layer ${layerValue}.`;
      isError = true;
      break;
    case 'inactive':
      message = `You missed the last round. You are now on layer ${layerValue}.`;
      isError = true;
      break;
    case 'winner':
      message = `You won the last round! You remain on layer ${layerValue}.`;
      break;
    case 'ready':
      message = 'Strategy locked. Waiting for the next round.';
      break;
    case 'waiting':
    default:
      message = 'Choose your strategy to lock it in before the next round.';
      break;
  }
  showFeedback(elements.playerStatus, message, isError);
}

function createCell(text) {
  const cell = document.createElement('td');
  cell.textContent = text;
  return cell;
}

function resolveNames(playerIds) {
  if (!Array.isArray(playerIds) || playerIds.length === 0) {
    return [];
  }
  const lookup = new Map(state.players.map((player) => [player.id, player]));
  return playerIds
    .map((id) => lookup.get(id))
    .filter(Boolean)
    .map((player) => player.name);
}

function highlightSelectedMove(move) {
  elements.moveButtons.forEach((button) => {
    const isSelected = button.dataset.move === move;
    button.dataset.selected = isSelected ? 'true' : 'false';
  });
}

function updateCountdown() {
  if (!elements.nextRoundTimer) {
    return;
  }

  if (!state.nextRoundStartsAt) {
    elements.nextRoundTimer.textContent = '';
    return;
  }

  const targetTime = Date.parse(state.nextRoundStartsAt);
  if (Number.isNaN(targetTime)) {
    elements.nextRoundTimer.textContent = '';
    return;
  }

  const diffMs = targetTime - Date.now();
  if (diffMs <= 0) {
    elements.nextRoundTimer.textContent = 'Next auto round starting...';
    return;
  }

  const totalSeconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const parts = [];

  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  parts.push(`${seconds}s`);

  elements.nextRoundTimer.textContent = `Next auto round in ${parts.join(' ')}.`;
}

function restorePlayerFromSession() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return;
    }
    state.player = JSON.parse(raw);
  } catch (error) {
    console.warn('Failed to restore session player', error);
  }
}

function persistPlayerToSession() {
  if (!state.player) {
    return;
  }
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state.player));
}

function clearStoredPlayer() {
  sessionStorage.removeItem(STORAGE_KEY);
}

init();
