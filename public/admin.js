const { api, showFeedback, capitalize, formatRoundMeta } = window.SPR;

const ADMIN_CODE = 'test';
const STORAGE_KEY = 'spr-current-admin';

const state = {
  admin: null,
  adminName: '',
  players: [],
  round: null,
  lastOutcome: null,
  nextRoundStartsAt: null,
  roundIntervalMs: null
};

const elements = {
  accessSection: document.getElementById('access-section'),
  accessForm: document.getElementById('access-form'),
  accessCodeInput: document.getElementById('access-code'),
  adminNameInput: document.getElementById('admin-name'),
  accessFeedback: document.getElementById('access-feedback'),
  adminPanel: document.getElementById('admin-panel'),
  adminSummary: document.getElementById('admin-summary'),
  adminFeedback: document.getElementById('admin-feedback'),
  startRoundButton: document.getElementById('start-round-button'),
  resetGameButton: document.getElementById('reset-game-button'),
  refreshButton: document.getElementById('refresh-button'),
  playersTableBody: document.getElementById('players-table-body'),
  roundOutcome: document.getElementById('round-outcome'),
  nextRoundTimer: document.getElementById('next-round-timer'),
  gameStateSection: document.getElementById('game-state')
};

let refreshIntervalId = null;
let countdownIntervalId = null;

function init() {
  restoreAdminFromSession();
  wireEventHandlers();
  updateVisibility();

  if (state.admin) {
    showFeedback(elements.accessFeedback, '', false);
    onAccessGranted();
  }
}

function wireEventHandlers() {
  if (elements.accessForm) {
    elements.accessForm.addEventListener('submit', onAccessSubmit);
  }
  if (elements.startRoundButton) {
    elements.startRoundButton.addEventListener('click', onStartRound);
  }
  if (elements.resetGameButton) {
    elements.resetGameButton.addEventListener('click', onResetGame);
  }
  if (elements.refreshButton) {
    elements.refreshButton.addEventListener('click', refreshState);
  }
}

async function onAccessSubmit(event) {
  event.preventDefault();
  const code = (elements.accessCodeInput.value || '').trim();
  const name = (elements.adminNameInput.value || '').trim();

  if (code !== ADMIN_CODE) {
    showFeedback(elements.accessFeedback, 'Invalid access code.', true);
    return;
  }

  if (!name) {
    showFeedback(elements.accessFeedback, 'Please provide an admin name.', true);
    return;
  }

  state.adminName = name;

  try {
    await ensureAdminRegistered();
    showFeedback(elements.accessFeedback, 'Access granted. Welcome to the control room.', false);
    onAccessGranted();
  } catch (error) {
    showFeedback(elements.accessFeedback, error.message, true);
  }
}

async function ensureAdminRegistered() {
  await refreshState();

  const existing = state.players.find(
    (player) => player.role === 'admin' && player.name === state.adminName
  );

  if (existing) {
    state.admin = existing;
    persistAdminToSession();
    return;
  }

  const response = await api.request('/api/players', {
    method: 'POST',
    body: { name: state.adminName, role: 'admin' }
  });
  state.admin = response.player;
  persistAdminToSession();
  await refreshState();
}

function onAccessGranted() {
  updateVisibility();
  renderAdminSummary();
  refreshState();
  startPolling();
}

async function onStartRound() {
  if (!state.admin) {
    return;
  }

  toggleAdminControls(true);
  try {
    const response = await api.request('/api/game/start', {
      method: 'POST',
      body: { adminId: state.admin.id }
    });
    if (response.state) {
      state.players = response.state.players || [];
      state.round = response.state.round || null;
      syncAdminFromPlayers();
    }
    showFeedback(elements.adminFeedback, response.outcome.message, false);
    refreshState();
  } catch (error) {
    showFeedback(elements.adminFeedback, error.message, true);
  } finally {
    toggleAdminControls(false);
  }
}

async function onResetGame() {
  if (!state.admin) {
    return;
  }

  toggleAdminControls(true);
  try {
    const response = await api.request('/api/game/reset', { method: 'POST' });
    showFeedback(elements.adminFeedback, response.message, false);
    state.players = response.state.players || [];
    state.round = response.state.round || null;
    state.lastOutcome = response.state.lastOutcome || null;
    state.nextRoundStartsAt = response.state.nextRoundStartsAt || null;
    stopPolling();
    clearStoredAdmin();
    state.admin = null;
    await ensureAdminRegistered();
    showFeedback(
      elements.accessFeedback,
      'Game reset. Admin session refreshed with a new registration.',
      false
    );
    onAccessGranted();
  } catch (error) {
    showFeedback(elements.adminFeedback, error.message, true);
  } finally {
    toggleAdminControls(false);
  }
}

function toggleAdminControls(disabled) {
  if (elements.startRoundButton) {
    elements.startRoundButton.disabled = disabled;
  }
  if (elements.resetGameButton) {
    elements.resetGameButton.disabled = disabled;
  }
}

function startPolling() {
  if (refreshIntervalId === null) {
    refreshIntervalId = setInterval(refreshState, 4000);
  }
  if (countdownIntervalId === null) {
    countdownIntervalId = setInterval(updateCountdown, 1000);
  }
}

function stopPolling() {
  if (refreshIntervalId !== null) {
    clearInterval(refreshIntervalId);
    refreshIntervalId = null;
  }
  if (countdownIntervalId !== null) {
    clearInterval(countdownIntervalId);
    countdownIntervalId = null;
  }
}

async function refreshState() {
  try {
    const data = await api.request('/api/state');
    state.players = data.players || [];
    state.round = data.round || null;
    state.lastOutcome = data.lastOutcome || null;
    state.nextRoundStartsAt = data.nextRoundStartsAt || null;
    state.roundIntervalMs = data.roundIntervalMs || state.roundIntervalMs;
    syncAdminFromPlayers();
    renderState();
    updateCountdown();
  } catch (error) {
    console.error('Failed to refresh state', error);
  }
}

function syncAdminFromPlayers() {
  if (!state.admin) {
    return;
  }

  const fromServer = state.players.find((player) => player.id === state.admin.id);
  if (fromServer) {
    state.admin = fromServer;
    persistAdminToSession();
  } else {
    handleAdminMissing();
  }
}

function handleAdminMissing() {
  stopPolling();
  showFeedback(
    elements.adminFeedback,
    'Your admin session expired. Please re-enter the access code.',
    true
  );
  showFeedback(
    elements.accessFeedback,
    'Your admin record no longer exists. Enter the access code to continue.',
    true
  );
  clearStoredAdmin();
  state.admin = null;
  updateVisibility();
}

function renderState() {
  renderPlayersTable();
  renderRoundOutcome();
  renderAdminSummary();
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

function renderAdminSummary() {
  if (!elements.adminSummary) {
    return;
  }

  if (!state.admin) {
    elements.adminSummary.textContent = '';
    return;
  }

  elements.adminSummary.textContent = `Access granted as admin ${state.admin.name}.`;
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

function createCell(text) {
  const cell = document.createElement('td');
  cell.textContent = text;
  return cell;
}

function restoreAdminFromSession() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return;
    }
    const stored = JSON.parse(raw);
    state.admin = stored.admin || null;
    state.adminName = stored.name || (stored.admin ? stored.admin.name : '');
  } catch (error) {
    console.warn('Failed to restore admin session', error);
  }
}

function persistAdminToSession() {
  if (!state.admin) {
    return;
  }
  const payload = {
    admin: state.admin,
    name: state.adminName || state.admin.name
  };
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function clearStoredAdmin() {
  sessionStorage.removeItem(STORAGE_KEY);
}

function updateVisibility() {
  const hasAdmin = Boolean(state.admin);
  if (elements.accessSection) {
    elements.accessSection.classList.toggle('hidden', hasAdmin);
  }
  if (elements.adminPanel) {
    elements.adminPanel.classList.toggle('hidden', !hasAdmin);
  }
  if (elements.gameStateSection) {
    elements.gameStateSection.classList.toggle('hidden', !hasAdmin);
  }
}

init();
