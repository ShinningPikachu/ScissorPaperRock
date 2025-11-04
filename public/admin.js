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
  eliminationBanner: document.getElementById('elimination-banner'),
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
  renderEliminationBanner();
  renderRoundOutcome();
  renderStageOccupancy();
  renderStrategySummary();
  renderPlayersTable();
  renderAdminSummary();
}

function getLatestOutcome() {
  if (state.round && state.round.outcome) {
    return state.round.outcome;
  }
  if (state.lastOutcome) {
    return state.lastOutcome;
  }
  return null;
}

function renderEliminationBanner() {
  if (!elements.eliminationBanner) {
    return;
  }

  const outcome = getLatestOutcome();
  const events = Array.isArray(outcome?.eliminationEvents) ? outcome.eliminationEvents : [];
  const roundPhase =
    state.round && typeof state.round.phase === 'string' ? state.round.phase : '';

  if (!events.length || (roundPhase && roundPhase !== 'waiting')) {
    elements.eliminationBanner.classList.add('hidden');
    elements.eliminationBanner.innerHTML = '';
    return;
  }

  const descriptions = events.map((event) => {
    const name = typeof event.playerName === 'string' && event.playerName.length > 0 ? event.playerName : 'Unknown contender';
    if (Number.isFinite(event.eliminatedAt)) {
      return `${name} • Layer ${event.eliminatedAt}`;
    }
    return name;
  });

  elements.eliminationBanner.classList.remove('hidden');
  elements.eliminationBanner.innerHTML = '';

  const heading = document.createElement('p');
  heading.className = 'elimination-heading';
  heading.textContent = 'Elimination Alert';
  elements.eliminationBanner.appendChild(heading);

  const namesLine = document.createElement('p');
  namesLine.className = 'elimination-names';
  namesLine.textContent = descriptions.join(' | ');
  elements.eliminationBanner.appendChild(namesLine);

  const hint = document.createElement('p');
  hint.className = 'elimination-hint';
  hint.textContent = 'Countdown to the next round is live — give players time to adjust their strategy.';
  elements.eliminationBanner.appendChild(hint);
}

function getDuelHighlights() {
  const activeMatchups =
    state.round && Array.isArray(state.round.matchups) ? state.round.matchups : [];
  if (activeMatchups.length > 0) {
    return window.SPR.extractDuelHighlights(state.round);
  }

  const previousMatchups =
    state.lastOutcome && Array.isArray(state.lastOutcome.matchups)
      ? state.lastOutcome.matchups
      : [];

  if (previousMatchups.length > 0) {
    return window.SPR.extractDuelHighlights({ matchups: previousMatchups });
  }

  return window.SPR.extractDuelHighlights(null);
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
  const activeStage = currentMatchup ? currentMatchup.stage : null;
  const stageMatchups =
    activeStage === null || activeStage === undefined
      ? matchups
      : matchups.filter((matchup) => matchup && matchup.stage === activeStage);
  const stageIndex = stageMatchups.findIndex(
    (matchup) => matchup && currentMatchup && matchup.id === currentMatchup.id
  );
  const effectiveIndex = stageIndex >= 0 ? stageIndex : 0;

  if (elements.duelFighterA) {
    elements.duelFighterA.textContent = currentMatchup?.aName || 'Player A';
  }
  if (elements.duelFighterB) {
    elements.duelFighterB.textContent =
      currentMatchup?.bName || 'Awaiting opponent';
  }

  if (elements.duelSubtext) {
    const totalPairs = stageMatchups.length;
    const stageLabel =
      activeStage === null || activeStage === undefined ? 'Arena' : `Layer ${activeStage}`;
    elements.duelSubtext.textContent =
      totalPairs > 1
        ? `${stageLabel}: ${totalPairs} duel${totalPairs === 1 ? '' : 's'} queued.`
        : `${stageLabel}: Clash in progress...`;
  }

  if (elements.duelLineup) {
    elements.duelLineup.innerHTML = '';
    stageMatchups.forEach((pair, index) => {
      const item = document.createElement('li');
      if (pair.bName) {
        item.textContent = `${pair.aName} vs ${pair.bName}`;
      } else {
        item.textContent = `${pair.aName} advances with a bye`;
      }
      if (index === effectiveIndex) {
        item.classList.add('active');
      }
      item.dataset.stage = pair.stage;
      elements.duelLineup.appendChild(item);
    });
  }
}

function renderStrategySummary() {
  if (!elements.strategySummaryBody) {
    return;
  }

  const duelHighlights = getDuelHighlights();
  const summary = window.SPR.summarizeStrategiesByLayer(state.players, { duelHighlights });
  const { totals } = summary;

  elements.strategySummaryBody.innerHTML = '';

  if (totals.total === 0) {
    const emptyRow = document.createElement('tr');
    const emptyCell = document.createElement('td');
    emptyCell.colSpan = 4;
    emptyCell.textContent = 'No strategies locked in yet.';
    emptyRow.appendChild(emptyCell);
    elements.strategySummaryBody.appendChild(emptyRow);
  } else {
    const totalsRow = document.createElement('tr');
    totalsRow.appendChild(createCell(totals.rock));
    totalsRow.appendChild(createCell(totals.paper));
    totalsRow.appendChild(createCell(totals.scissors));
    totalsRow.appendChild(createCell(totals.total));
    elements.strategySummaryBody.appendChild(totalsRow);
  }
}

function renderStageOccupancy() {
  if (!elements.stageOccupancyBody) {
    return;
  }

  const round = state.round || {};
  const activeMatchups =
    Array.isArray(round.matchups) && round.matchups.length > 0
      ? round.matchups
      : Array.isArray(state.lastOutcome?.matchups)
      ? state.lastOutcome.matchups
      : [];
  const duelHighlights = getDuelHighlights();
  const groups = window.SPR.groupPlayersByStage(state.players, {
    duelHighlights,
    matchups: activeMatchups
  });
  elements.stageOccupancyBody.innerHTML = '';

  if (groups.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'layer-player-empty';
    empty.textContent = 'No players on the board yet.';
    elements.stageOccupancyBody.appendChild(empty);
    return;
  }

  groups.forEach(({ layer, players, matchups }) => {
    const block = document.createElement('section');
    block.className = 'layer-block';

    const header = document.createElement('h4');
    header.className = 'layer-block-header';
    header.textContent = `Layer ${layer}`;
    block.appendChild(header);

    const playerList = document.createElement('div');
    playerList.className = 'layer-player-list';
    if (players.length === 0) {
      const emptyPlayers = document.createElement('p');
      emptyPlayers.className = 'layer-player-empty';
      emptyPlayers.textContent = 'No players in this layer.';
      playerList.appendChild(emptyPlayers);
    } else {
      players.forEach((player) => {
        const pill = document.createElement('span');
        pill.className = 'player-pill';
        if (player.isWinner) {
          pill.classList.add('winner');
        }
        if (player.isLoser) {
          pill.classList.add('loser');
        }
        if (!player.active) {
          pill.classList.add('eliminated');
        } else if (player.status === 'inactive') {
          pill.classList.add('inactive');
        }
        pill.textContent =
          player.status && player.status !== 'ready' && player.status !== 'waiting'
            ? `${player.name} (${player.status})`
            : player.name;
        playerList.appendChild(pill);
      });
    }
    block.appendChild(playerList);

    if (matchups.length === 0) {
      const emptyDuels = document.createElement('p');
      emptyDuels.className = 'layer-duel-empty';
      emptyDuels.textContent = 'No duels scheduled for this layer.';
      block.appendChild(emptyDuels);
    } else {
      const table = document.createElement('table');
      table.className = 'layer-duel-table';

      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      ['Player A', 'Player B', 'Result'].forEach((label) => {
        const th = document.createElement('th');
        th.textContent = label;
        headRow.appendChild(th);
      });
      thead.appendChild(headRow);
      table.appendChild(thead);

      const knownPlayerIds = new Set(players.map((player) => player.id));
      const tbody = document.createElement('tbody');
      matchups.forEach((matchup) => {
        const row = document.createElement('tr');

        const aCell = document.createElement('td');
        const showAName =
          layer >= 0 ||
          matchup.revealed ||
          (matchup.aId && knownPlayerIds.has(matchup.aId));
        aCell.textContent = showAName ? matchup.aName || 'Player A' : 'Awaiting result';

        const bCell = document.createElement('td');
        let opponentLabel = 'Awaiting opponent';
        if (matchup.bId) {
          const showBName =
            layer >= 0 ||
            matchup.revealed ||
            knownPlayerIds.has(matchup.bId);
          opponentLabel = showBName ? matchup.bName || 'Player B' : 'Awaiting result';
        }
        bCell.textContent = opponentLabel;

        const statusCell = document.createElement('td');
        statusCell.className = 'duel-status';

        const result = matchup.result || 'pending';
        const winnersSet = new Set(
          Array.isArray(matchup.winnerIds)
            ? matchup.winnerIds.filter((id) => typeof id === 'string' && id.length > 0)
            : []
        );
        if (winnersSet.size === 0) {
          if (result === 'a') {
            winnersSet.add(matchup.aId);
          } else if (result === 'b' || result === 'bye') {
            const fallbackWinner = matchup.bId != null ? matchup.bId : matchup.aId;
            if (fallbackWinner) {
              winnersSet.add(fallbackWinner);
            }
          }
        }

        const loserIds = [];
        if (typeof matchup.loserId === 'string' && matchup.loserId.length > 0) {
          loserIds.push(matchup.loserId);
        } else if (result === 'a') {
          loserIds.push(matchup.bId);
        } else if (result === 'b') {
          loserIds.push(matchup.aId);
        }
        const losersSet = new Set(
          loserIds.filter((id) => typeof id === 'string' && id.length > 0)
        );

        if (matchup.aId && winnersSet.has(matchup.aId)) {
          aCell.classList.add('duel-winner');
        }
        if (matchup.bId && winnersSet.has(matchup.bId)) {
          bCell.classList.add('duel-winner');
        }
        if (matchup.aId && losersSet.has(matchup.aId)) {
          aCell.classList.add('duel-loser');
        }
        if (matchup.bId && losersSet.has(matchup.bId)) {
          bCell.classList.add('duel-loser');
        }

        if (result === 'a' || result === 'b') {
          statusCell.classList.add('resolved');
          statusCell.textContent =
            typeof matchup.loserNextLayer === 'number'
              ? `Loser to Layer ${matchup.loserNextLayer}`
              : 'Resolved';
        } else if (result === 'double-win') {
          statusCell.classList.add('resolved');
          statusCell.textContent = 'Both advance';
        } else if (result === 'bye') {
          if (!matchup.bId) {
            bCell.textContent = 'No opponent';
          }
          aCell.classList.add('duel-winner');
          statusCell.classList.add('bye', 'resolved');
          statusCell.textContent = 'Bye';
        } else if (result === 'tie') {
          aCell.classList.add('duel-tie');
          bCell.classList.add('duel-tie');
          statusCell.classList.add('tie', 'resolved');
          statusCell.textContent = 'Tie';
        } else {
          statusCell.classList.add('pending');
          statusCell.textContent = 'Pending';
        }

        row.appendChild(aCell);
        row.appendChild(bCell);
        row.appendChild(statusCell);
        tbody.appendChild(row);
      });

      table.appendChild(tbody);
      block.appendChild(table);
    }

    elements.stageOccupancyBody.appendChild(block);
  });
}

function renderPlayersTable() {
  if (!elements.playersTableBody) {
    return;
  }

  elements.playersTableBody.innerHTML = '';
  const duelHighlights = getDuelHighlights();
  const winners = duelHighlights.winners || new Set();
  const losers = duelHighlights.losers || new Map();

  state.players
    .filter((player) => player.status !== 'eliminated')
    .forEach((player) => {
      const row = document.createElement('tr');
      row.classList.add('player-row');
      if (winners.has(player.id)) {
        row.classList.add('player-row-winner');
      } else if (losers.has(player.id)) {
        row.classList.add('player-row-loser');
      }

      row.appendChild(createCell(player.name));
      row.appendChild(createCell(capitalize(player.role)));

      const layerValue =
        typeof player.layer === 'number' && Number.isFinite(player.layer)
          ? player.layer
          : 0;
      const effectiveLayer = losers.has(player.id) ? losers.get(player.id) : layerValue;
      row.appendChild(createCell(effectiveLayer));

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

  const outcome = getLatestOutcome();
  elements.roundOutcome.innerHTML = '';

  if (!outcome) {
    return;
  }

  const message = document.createElement('p');
  message.className = 'outcome-message';
  message.textContent = outcome.message || 'Round resolved.';
  elements.roundOutcome.appendChild(message);

  if (Array.isArray(outcome.winningMoves) && outcome.winningMoves.length > 0) {
    const moves = outcome.winningMoves.map((move) => capitalize(move));
    elements.roundOutcome.insertAdjacentHTML('beforeend', formatRoundMeta('Winning Moves', moves));
  }

  if (Array.isArray(outcome.eliminationEvents) && outcome.eliminationEvents.length > 0) {
    const eliminationMeta = document.createElement('p');
    eliminationMeta.className = 'round-meta elimination-meta';
    const label = document.createElement('span');
    label.textContent = 'Eliminated: ';
    eliminationMeta.appendChild(label);

    const details = outcome.eliminationEvents.map((event) => {
      const name = typeof event.playerName === 'string' && event.playerName.length > 0 ? event.playerName : 'Unknown contender';
      if (Number.isFinite(event.eliminatedAt)) {
        return `${name} (Layer ${event.eliminatedAt})`;
      }
      return name;
    });
    eliminationMeta.appendChild(document.createTextNode(details.join(', ')));
    elements.roundOutcome.appendChild(eliminationMeta);
  }
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

  elements.nextRoundTimer.classList.remove('countdown-active');
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
    elements.nextRoundTimer.classList.add('countdown-active');
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

  elements.nextRoundTimer.classList.add('countdown-active');
  elements.nextRoundTimer.textContent = `Next round begins in ${parts.join(' ')} — allow players to refine their strategy.`;
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
