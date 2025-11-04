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
  roundOutcome: document.getElementById('round-outcome'),
  eliminationBanner: document.getElementById('elimination-banner'),
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
  renderEliminationBanner();
  renderRoundOutcome();
  renderStageOccupancy();
  renderStrategySummary();
  updatePersonalSections();
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
  hint.textContent = 'The arena resets in a moment — refine your strategy before the next round.';
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
  elements.nextRoundTimer.textContent = `Next round begins in ${parts.join(' ')} — adjust your strategy now.`;
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
