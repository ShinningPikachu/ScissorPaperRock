const { api, showFeedback, capitalize, formatRoundMeta } = window.SPR;

const state = {
  player: null,
  players: [],
  round: null,
  availableMoves: [],
  lastOutcome: null,
  nextRoundStartsAt: null,
  roundIntervalMs: null,
  tournamentMode: false,
  activeTab: 'player-info'
};

const elements = {
  registrationForm: document.getElementById('registration-form'),
  registrationFeedback: document.getElementById('registration-feedback'),
  nameInput: document.getElementById('player-name'),
  playerActions: document.getElementById('player-actions'),
  playerSummary: document.getElementById('player-summary'),
  playerStatus: document.getElementById('player-status'),
  moveButtons: Array.from(
    document.querySelectorAll('#player-actions .move-grid button')
  ),
  tabButtons: Array.from(
    document.querySelectorAll('#player-actions .tab-button')
  ),
  tabPanels: Array.from(
    document.querySelectorAll('#player-actions .tab-panel')
  ),
  moveTabButton: document.querySelector(
    '#player-actions .tab-button[data-tab-target="move-selection"]'
  ),
  duelDisplay: document.getElementById('duel-display'),
  duelFighterA: document.getElementById('duel-fighter-a'),
  duelFighterB: document.getElementById('duel-fighter-b'),
  duelSubtext: document.getElementById('duel-subtext'),
  duelLineup: document.getElementById('duel-lineup'),
  stageOccupancyBody: document.getElementById('stage-occupancy-body'),
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
  setActiveTab(state.activeTab, { focus: false });
  refreshState();
  setInterval(refreshState, 4000);
  setInterval(updateCountdown, 1000);
}

function wireEventHandlers() {
  if (elements.registrationForm) {
    elements.registrationForm.addEventListener('submit', onRegister);
  }
  elements.moveButtons.forEach((button) => {
    button.addEventListener('click', () => onMoveSelected(button.dataset.move || null));
  });
  elements.tabButtons.forEach((button) => {
    button.addEventListener('click', () => {
      if (button.disabled) {
        return;
      }
      const target = button.dataset.tabTarget;
      setActiveTab(target, { focus: true });
    });
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
    const selectedMove = move || null;
    const response = await api.request(`/api/players/${state.player.id}/move`, {
      method: 'POST',
      body: { move: selectedMove }
    });
    state.player = response.player;
    persistPlayerToSession();
    highlightSelectedMove(selectedMove);
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
    state.tournamentMode = Boolean(data.tournamentMode);
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
  renderDuelDisplay();
  renderRoundOutcome();
  renderStageOccupancy();
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

function updatePersonalSections() {
  if (!elements.playerActions) {
    return;
  }

  const hasPlayer = Boolean(state.player);
  elements.playerActions.classList.toggle('hidden', !hasPlayer);

  if (!hasPlayer) {
    if (elements.moveTabButton) {
      elements.moveTabButton.disabled = true;
    }
    highlightSelectedMove(null);
    showFeedback(elements.playerStatus, '', false);
    elements.playerSummary.textContent = '';
    setActiveTab('player-info', { focus: false });
    return;
  }

  const layerValue =
    typeof state.player.layer === 'number' && Number.isFinite(state.player.layer)
      ? state.player.layer
      : 0;

  elements.playerSummary.textContent = `Logged in as ${state.player.name} (Layer ${layerValue}).`;

  const isEliminated = state.player.active === false;

  elements.moveButtons.forEach((button) => {
    if (!button) {
      return;
    }
    button.disabled = isEliminated;
  });
  if (elements.moveTabButton) {
    elements.moveTabButton.disabled = isEliminated;
  }

  if (isEliminated) {
    highlightSelectedMove(null);
    showFeedback(
      elements.playerStatus,
      'You have been eliminated from the tournament. Enjoy spectating the remaining rounds.',
      true
    );
    if (state.activeTab === 'move-selection') {
      setActiveTab('player-info', { focus: false });
    }
    return;
  }

  if (elements.moveTabButton) {
    elements.moveTabButton.disabled = false;
  }

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
  const normalized = typeof move === 'string' ? move : null;
  elements.moveButtons.forEach((button) => {
    const buttonMove = button.dataset.move || null;
    const isSelected = buttonMove === normalized;
    button.dataset.selected = isSelected ? 'true' : 'false';
  });
}

function setActiveTab(tabName, { focus = false } = {}) {
  if (!tabName) {
    return;
  }

  let matched = false;

  elements.tabButtons.forEach((button) => {
    const target = button.dataset.tabTarget;
    const isActive = target === tabName;
    if (isActive) {
      matched = true;
    }
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    if (isActive && focus) {
      button.focus();
    }
  });

  elements.tabPanels.forEach((panel) => {
    const target = panel.dataset.tabPanel;
    panel.classList.toggle('active', target === tabName);
  });

  if (matched) {
    state.activeTab = tabName;
  }
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
        elements.nextRoundTimer.textContent = 'Waiting for the admin to start the next round.';
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
      elements.nextRoundTimer.textContent = 'Waiting for the admin to start the next round.';
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
