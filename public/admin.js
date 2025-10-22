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
  roundIntervalMs: null,
  tournamentMode: false
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
  addBotsForm: document.getElementById('add-bots-form'),
  botCountInput: document.getElementById('bot-count'),
  botNamesInput: document.getElementById('bot-names'),
  botStrategySelect: document.getElementById('bot-strategy'),
  addBotsButton: document.getElementById('add-bots-button'),
  refreshButton: document.getElementById('refresh-button'),
  duelDisplay: document.getElementById('duel-display'),
  duelFighterA: document.getElementById('duel-fighter-a'),
  duelFighterB: document.getElementById('duel-fighter-b'),
  duelSubtext: document.getElementById('duel-subtext'),
  duelLineup: document.getElementById('duel-lineup'),
  stageOccupancyBody: document.getElementById('stage-occupancy-body'),
  playersTableBody: document.getElementById('players-table-body'),
  roundOutcome: document.getElementById('round-outcome'),
  nextRoundTimer: document.getElementById('next-round-timer'),
  gameStateSection: document.getElementById('game-state'),
  strategySummaryBody: document.getElementById('strategy-summary-body')
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
  if (elements.addBotsForm) {
    elements.addBotsForm.addEventListener('submit', onAddBots);
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
      state.lastOutcome = response.state.lastOutcome || null;
      state.nextRoundStartsAt = response.state.nextRoundStartsAt || null;
      state.tournamentMode =
        typeof response.state.tournamentMode === 'boolean'
          ? response.state.tournamentMode
          : state.tournamentMode;
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

async function onAddBots(event) {
  event.preventDefault();
  if (!state.admin) {
    return;
  }

  const rawCount = elements.botCountInput ? elements.botCountInput.value : '';
  const parsedCount = Number.parseInt(rawCount, 10);
  const rawNames = elements.botNamesInput ? elements.botNamesInput.value : '';
  const strategyValue = elements.botStrategySelect
    ? elements.botStrategySelect.value
    : 'random';

  const parsedNames = rawNames
    .split(/[\r\n,]+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  const allowedStrategies = new Set(['random', 'rock', 'paper', 'scissors']);
  const normalizedStrategy =
    typeof strategyValue === 'string' && strategyValue.trim().length > 0
      ? strategyValue.trim().toLowerCase()
      : 'random';

  if (!allowedStrategies.has(normalizedStrategy)) {
    showFeedback(elements.adminFeedback, 'Choose a valid bot strategy.', true);
    return;
  }

  if (parsedNames.length > 24) {
    showFeedback(elements.adminFeedback, 'You can add up to 24 bots per batch.', true);
    return;
  }

  const usingNames = parsedNames.length > 0;

  if (!usingNames) {
    if (!Number.isFinite(parsedCount) || parsedCount <= 0) {
      showFeedback(elements.adminFeedback, 'Enter a valid number of bots to add.', true);
      return;
    }

    if (parsedCount > 24) {
      showFeedback(elements.adminFeedback, 'You can add up to 24 bots at a time.', true);
      return;
    }
  }

  const payload = {
    adminId: state.admin.id,
    strategy: normalizedStrategy
  };

  if (usingNames) {
    payload.names = parsedNames;
  } else {
    payload.count = parsedCount;
  }

  toggleAdminControls(true);
  try {
    const response = await api.request('/api/bots', {
      method: 'POST',
      body: payload
    });

    showFeedback(elements.adminFeedback, response.message, false);
    if (elements.botNamesInput) {
      elements.botNamesInput.value = '';
    }
    state.players = response.state.players || [];
    state.round = response.state.round || null;
    state.lastOutcome = response.state.lastOutcome || null;
    state.nextRoundStartsAt = response.state.nextRoundStartsAt || null;
    state.tournamentMode =
      typeof response.state.tournamentMode === 'boolean'
        ? response.state.tournamentMode
        : state.tournamentMode;
    renderState();
  } catch (error) {
    showFeedback(elements.adminFeedback, error.message, true);
  } finally {
    toggleAdminControls(false);
  }
}

function toggleAdminControls(disabled) {
  const activePlayers = (state.players || []).filter(
    (player) => player.role === 'player' && player.active !== false
  ).length;

  const startDisabled = disabled || state.tournamentMode || activePlayers <= 1;
  if (elements.startRoundButton) {
    elements.startRoundButton.disabled = startDisabled;
  }
  if (elements.resetGameButton) {
    elements.resetGameButton.disabled = disabled;
  }
  const botControlsDisabled = disabled || state.tournamentMode;
  if (elements.addBotsButton) {
    elements.addBotsButton.disabled = botControlsDisabled;
  }
  if (elements.botCountInput) {
    elements.botCountInput.disabled = botControlsDisabled;
  }
  if (elements.botNamesInput) {
    elements.botNamesInput.disabled = botControlsDisabled;
  }
  if (elements.botStrategySelect) {
    elements.botStrategySelect.disabled = botControlsDisabled;
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
    state.tournamentMode = Boolean(data.tournamentMode);
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
  renderDuelDisplay();
  renderRoundOutcome();
  renderStageOccupancy();
  renderStrategySummary();
  renderPlayersTable();
  renderAdminSummary();
}

function renderDuelDisplay() {
  if (!elements.duelDisplay) {
    return;
  }

  const round = state.round || {};
  const matchups = Array.isArray(round.matchups) ? round.matchups : [];

  if (round.phase !== 'duel' || matchups.length === 0) {
    elements.duelDisplay.classList.add('hidden');
    elements.duelDisplay.classList.remove('active');
    return;
  }

  elements.duelDisplay.classList.remove('hidden');
  elements.duelDisplay.classList.add('active');

  const safeIndex =
    typeof round.currentMatchupIndex === 'number' && round.currentMatchupIndex >= 0
      ? Math.min(round.currentMatchupIndex, matchups.length - 1)
      : 0;
  const currentMatchup = matchups[safeIndex] || matchups[0];

  if (elements.duelFighterA) {
    elements.duelFighterA.textContent = currentMatchup?.aName || 'Player A';
  }
  if (elements.duelFighterB) {
    elements.duelFighterB.textContent =
      currentMatchup?.bName || 'Awaiting opponent';
  }

  if (elements.duelSubtext) {
    const totalPairs = matchups.length;
    elements.duelSubtext.textContent =
      totalPairs > 1
        ? `Round ${round.number || ''}: ${totalPairs} duels lined up.`
        : 'Clash in progress...';
  }

  if (elements.duelLineup) {
    elements.duelLineup.innerHTML = '';
    matchups.forEach((pair, index) => {
      const item = document.createElement('li');
      if (pair.bName) {
        item.textContent = `${pair.aName} vs ${pair.bName}`;
      } else {
        item.textContent = `${pair.aName} advances with a bye`;
      }
      if (index === safeIndex) {
        item.classList.add('active');
      }
      elements.duelLineup.appendChild(item);
    });
  }
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

function renderStageOccupancy() {
  if (!elements.stageOccupancyBody) {
    return;
  }

  const groups = window.SPR.groupPlayersByStage(state.players);
  elements.stageOccupancyBody.innerHTML = '';

  if (groups.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 2;
    cell.textContent = 'No players on the board yet.';
    row.appendChild(cell);
    elements.stageOccupancyBody.appendChild(row);
    return;
  }

  groups.forEach(({ layer, players }) => {
    const row = document.createElement('tr');
    row.appendChild(createCell(layer));

    const playersCell = document.createElement('td');
    if (players.length === 0) {
      playersCell.textContent = '—';
    } else {
      players.forEach((player) => {
        const pill = document.createElement('span');
        pill.className = 'player-pill';
        if (!player.active) {
          pill.classList.add('eliminated');
        } else if (player.status === 'inactive') {
          pill.classList.add('inactive');
        }
        pill.textContent =
          player.status && player.status !== 'ready' && player.status !== 'waiting'
            ? `${player.name} (${player.status})`
            : player.name;
        playersCell.appendChild(pill);
      });
    }

    row.appendChild(playersCell);
    elements.stageOccupancyBody.appendChild(row);
  });
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

  const activePlayers = (state.players || []).filter(
    (player) => player.role === 'player' && player.active !== false
  ).length;

  let statusMessage;
  if (state.tournamentMode) {
    statusMessage = 'Tournament in progress.';
  } else if (activePlayers <= 1 && (state.players || []).length > 0) {
    statusMessage = 'Tournament finished. Reset the game to start a new match.';
  } else {
    statusMessage = 'Waiting to start the next round.';
  }

  elements.adminSummary.textContent = `Access granted as admin ${state.admin.name}. Active players remaining: ${activePlayers}. ${statusMessage}`;

  if (elements.startRoundButton) {
    elements.startRoundButton.disabled = state.tournamentMode || activePlayers <= 1;
  }
  if (elements.addBotsButton) {
    elements.addBotsButton.disabled = state.tournamentMode;
  }
  if (elements.botCountInput) {
    elements.botCountInput.disabled = state.tournamentMode;
  }
  if (elements.botNamesInput) {
    elements.botNamesInput.disabled = state.tournamentMode;
  }
  if (elements.botStrategySelect) {
    elements.botStrategySelect.disabled = state.tournamentMode;
  }
}

function updateCountdown() {
  if (!elements.nextRoundTimer) {
    return;
  }

  const roundPhase =
    state.round && typeof state.round.phase === 'string' ? state.round.phase : '';
  const activePlayers = (state.players || []).filter(
    (player) => player.role === 'player' && player.active !== false
  ).length;

  if (!state.nextRoundStartsAt) {
    if (state.tournamentMode) {
      if (roundPhase === 'duel') {
        elements.nextRoundTimer.textContent = 'Duel in progress...';
      } else if (roundPhase === 'processing' || roundPhase === 'competing') {
        elements.nextRoundTimer.textContent = 'Round in progress...';
      } else if (activePlayers <= 1 && state.lastOutcome) {
        elements.nextRoundTimer.textContent = 'Tournament finished.';
      } else {
        elements.nextRoundTimer.textContent = 'Scheduling next round...';
      }
    } else {
      if (roundPhase === 'duel') {
        elements.nextRoundTimer.textContent = 'Duel in progress...';
      } else if (activePlayers <= 1 && state.lastOutcome) {
        elements.nextRoundTimer.textContent = 'Tournament finished.';
      } else {
        elements.nextRoundTimer.textContent = 'Waiting for you to start the next round.';
      }
    }
    return;
  }

  const targetTime = Date.parse(state.nextRoundStartsAt);
  if (Number.isNaN(targetTime)) {
    if (state.tournamentMode) {
      if (roundPhase === 'duel') {
        elements.nextRoundTimer.textContent = 'Duel in progress...';
      } else if (roundPhase === 'processing' || roundPhase === 'competing') {
        elements.nextRoundTimer.textContent = 'Round in progress...';
      } else if (activePlayers <= 1 && state.lastOutcome) {
        elements.nextRoundTimer.textContent = 'Tournament finished.';
      } else {
        elements.nextRoundTimer.textContent = 'Scheduling next round...';
      }
    } else if (roundPhase === 'duel') {
      elements.nextRoundTimer.textContent = 'Duel in progress...';
    } else if (activePlayers <= 1 && state.lastOutcome) {
      elements.nextRoundTimer.textContent = 'Tournament finished.';
    } else {
      elements.nextRoundTimer.textContent = 'Waiting for you to start the next round.';
    }
    return;
  }

  const diffMs = targetTime - Date.now();
  if (diffMs <= 0) {
    elements.nextRoundTimer.textContent = 'Next round starting...';
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

  elements.nextRoundTimer.textContent = `Next round begins in ${parts.join(' ')}.`;
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
