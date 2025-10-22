const { api, showFeedback, capitalize, formatRoundMeta, formatRole } = window.SPR;

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
  botForm: document.getElementById('bot-form'),
  botCountInput: document.getElementById('bot-count'),
  botFeedback: document.getElementById('bot-feedback'),
  addBotsButton: document.getElementById('add-bots-button'),
  startRoundButton: document.getElementById('start-round-button'),
  resetGameButton: document.getElementById('reset-game-button'),
  refreshButton: document.getElementById('refresh-button'),
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
  if (elements.botForm) {
    elements.botForm.addEventListener('submit', onAddBots);
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
  showFeedback(elements.botFeedback, '', false);
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

async function onAddBots(event) {
  event.preventDefault();

  if (!state.admin) {
    return;
  }

  const rawValue = elements.botCountInput ? elements.botCountInput.value : '';
  const count = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(count) || count <= 0) {
    showFeedback(elements.botFeedback, 'Enter how many bots to add (at least 1).', true);
    return;
  }

  if (count > 24) {
    showFeedback(elements.botFeedback, 'Please add 24 bots or fewer at a time.', true);
    return;
  }

  const roundPhase = state.round?.phase || 'waiting';
  if (roundPhase !== 'waiting') {
    showFeedback(
      elements.botFeedback,
      'Bots can only be added while the arena is waiting for the next round.',
      true
    );
    return;
  }

  toggleBotControls(true);
  try {
    const response = await api.request('/api/bots', {
      method: 'POST',
      body: { adminId: state.admin.id, count }
    });

    if (response.state) {
      state.players = response.state.players || [];
      state.round = response.state.round || null;
      state.lastOutcome = response.state.lastOutcome || null;
      state.nextRoundStartsAt = response.state.nextRoundStartsAt || null;
      state.roundIntervalMs = response.state.roundIntervalMs || state.roundIntervalMs;
      syncAdminFromPlayers();
      renderState();
      updateCountdown();
    } else {
      await refreshState();
    }

    if (elements.botForm) {
      elements.botForm.reset();
    }

    showFeedback(elements.botFeedback, response.message, false);
  } catch (error) {
    showFeedback(elements.botFeedback, error.message, true);
  } finally {
    toggleBotControls(false);
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

function toggleBotControls(disabled) {
  if (elements.botCountInput) {
    elements.botCountInput.disabled = disabled;
  }
  if (elements.addBotsButton) {
    elements.addBotsButton.disabled = disabled;
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
  renderRoundOutcome();
  renderStrategySummary();
  renderPlayersTable();
  renderAdminSummary();
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
    const roleLabel = formatRole(player) || capitalize(player.role);
    row.appendChild(createCell(roleLabel));

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

  const roundInfo = state.round || {};
  const phase = roundInfo.phase;

  if (phase === 'processing' || phase === 'competing') {
    const phaseMessage =
      phase === 'processing'
        ? 'Preparing the arena. Competition begins shortly.'
        : 'Competition underway! Players are battling it out.';
    const animation =
      phase === 'competing'
        ? '<div class="phase-visual"><span></span><span></span><span></span></div>'
        : '';

    elements.roundOutcome.innerHTML = `
      <div class="round-phase ${phase}">
        <div class="phase-message">${phaseMessage}</div>
        ${animation}
        <div class="phase-countdown" data-phase-countdown="${phase}"></div>
      </div>
    `;
    updatePhaseCountdown();
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
    formatRoundMeta('Dropped a stage', resolveNames(outcome.eliminatedPlayerIds)),
    formatRoundMeta('Missed the round', resolveNames(outcome.inactivePlayerIds))
  ];

  elements.roundOutcome.innerHTML = details.filter(Boolean).join(' ');
}

function updatePhaseCountdown() {
  if (!elements.roundOutcome) {
    return;
  }

  const countdownElement = elements.roundOutcome.querySelector('[data-phase-countdown]');
  const roundInfo = state.round || {};
  const phase = roundInfo.phase;

  if (!countdownElement || (phase !== 'processing' && phase !== 'competing')) {
    if (countdownElement) {
      countdownElement.textContent = '';
    }
    return;
  }

  const endsAt = Date.parse(roundInfo.phaseEndsAt || '');
  if (Number.isNaN(endsAt)) {
    countdownElement.textContent = '';
    return;
  }

  const remainingMs = endsAt - Date.now();
  if (remainingMs <= 0) {
    countdownElement.textContent =
      phase === 'processing' ? 'Competition starting...' : 'Resolving...';
    return;
  }

  const remainingSeconds = Math.ceil(remainingMs / 1000);
  const label = phase === 'processing' ? 'Competition starts in' : 'Resolving in';
  countdownElement.textContent = `${label} ${remainingSeconds}s`;
}

function renderAdminSummary() {
  if (!elements.adminSummary) {
    return;
  }

  if (!state.admin) {
    elements.adminSummary.textContent = '';
    return;
  }

  const competitors = state.players.filter((player) => player.role === 'player');
  const bots = competitors.filter((player) => player.isBot).length;
  const humans = competitors.length - bots;
  const summaryParts = [`Access granted as admin ${state.admin.name}.`];

  if (competitors.length === 0) {
    summaryParts.push('No competitors have joined yet.');
  } else {
    const humanLabel = humans === 1 ? 'human' : 'humans';
    const botLabel = bots === 1 ? 'bot' : 'bots';
    const competitorLabel = competitors.length === 1 ? 'competitor' : 'competitors';
    summaryParts.push(
      `The lobby has ${competitors.length} ${competitorLabel} (${humans} ${humanLabel}, ${bots} ${botLabel}).`
    );
  }

  elements.adminSummary.textContent = summaryParts.join(' ');
}

function updateCountdown() {
  updatePhaseCountdown();

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
