(function () {
  const api = {
    async request(path, { method = 'GET', body } = {}) {
      const options = { method, headers: {} };

      if (body !== undefined) {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
      }

      const response = await fetch(path, options);
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        const message = payload.error || 'Request failed.';
        throw new Error(message);
      }

      return payload;
    }
  };

  function showFeedback(element, message, isError) {
    if (!element) {
      return;
    }
    element.textContent = message;
    element.classList.remove('positive', 'negative');
    if (!message) {
      return;
    }
    element.classList.add(isError ? 'negative' : 'positive');
  }

  function capitalize(value) {
    if (!value) {
      return '';
    }
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  function formatRoundMeta(label, names) {
    if (!Array.isArray(names) || names.length === 0) {
      return '';
    }

    const list = names.join(', ');
    return `<span class="round-meta">${label}: ${list}</span>`;
  }

  function extractDuelHighlights(round) {
    const winners = new Set();
    const losers = new Map();

    if (!round || typeof round !== 'object') {
      return { winners, losers };
    }

    const matchups = Array.isArray(round.matchups) ? round.matchups : [];
    matchups.forEach((matchup) => {
      if (!matchup || typeof matchup !== 'object') {
        return;
      }
      const outcome = matchup.result;
      if (!outcome || outcome === 'pending') {
        return;
      }
      const winnerId =
        typeof matchup.winnerId === 'string' && matchup.winnerId.length > 0
          ? matchup.winnerId
          : outcome === 'a'
          ? matchup.aId
          : outcome === 'b'
          ? matchup.bId
          : outcome === 'bye'
          ? matchup.aId
          : null;
      if (winnerId) {
        winners.add(winnerId);
      }

      const loserId =
        typeof matchup.loserId === 'string' && matchup.loserId.length > 0
          ? matchup.loserId
          : outcome === 'a'
          ? matchup.bId
          : outcome === 'b'
          ? matchup.aId
          : null;
      if (loserId) {
        const nextLayer =
          typeof matchup.loserNextLayer === 'number' && Number.isFinite(matchup.loserNextLayer)
            ? matchup.loserNextLayer
            : -1;
        losers.set(loserId, nextLayer);
      }
    });

    return { winners, losers };
  }

  function summarizeStrategiesByLayer(players, { duelHighlights } = {}) {
    const summary = new Map();
    const defaultMoves = ['rock', 'paper', 'scissors'];
    const totals = {
      rock: 0,
      paper: 0,
      scissors: 0,
      undecided: 0,
      total: 0
    };

    const loserMap =
      duelHighlights && duelHighlights.losers instanceof Map ? duelHighlights.losers : null;

    (Array.isArray(players) ? players : []).forEach((player) => {
      if (
        !player ||
        player.role !== 'player' ||
        player.active === false ||
        player.status === 'eliminated'
      ) {
        return;
      }

      const originalLayer =
        typeof player.layer === 'number' && Number.isFinite(player.layer)
          ? player.layer
          : 0;
      const layer =
        loserMap && loserMap.has(player.id) ? loserMap.get(player.id) : originalLayer;

      if (!summary.has(layer)) {
        summary.set(layer, {
          rock: 0,
          paper: 0,
          scissors: 0,
          undecided: 0,
          total: 0
        });
      }

      const bucket = summary.get(layer);
      const move = typeof player.move === 'string' ? player.move.toLowerCase() : '';

      if (defaultMoves.includes(move)) {
        bucket[move] += 1;
        totals[move] += 1;
      } else {
        bucket.undecided += 1;
        totals.undecided += 1;
      }

      bucket.total += 1;
      totals.total += 1;
    });

    const layers = Array.from(summary.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([layer, counts]) => ({ layer, counts }));

    return { layers, totals };
  }

  function groupPlayersByStage(players, { duelHighlights, roundPhase, visibleStage } = {}) {
    const map = new Map();
    const winnerSet =
      duelHighlights && duelHighlights.winners instanceof Set ? duelHighlights.winners : null;
    const loserMap =
      duelHighlights && duelHighlights.losers instanceof Map ? duelHighlights.losers : null;

    (Array.isArray(players) ? players : []).forEach((player) => {
      if (
        !player ||
        player.role !== 'player' ||
        player.status === 'eliminated'
      ) {
        return;
      }

      const originalLayer =
        typeof player.layer === 'number' && Number.isFinite(player.layer)
          ? player.layer
          : 0;
      const layer = loserMap && loserMap.has(player.id) ? loserMap.get(player.id) : originalLayer;

      if (
        roundPhase === 'duel' &&
        Number.isFinite(visibleStage) &&
        layer !== visibleStage
      ) {
        return;
      }

      if (!map.has(layer)) {
        map.set(layer, []);
      }
      map.get(layer).push({
        id: player.id,
        name: player.name,
        active: player.active !== false,
        status: player.status,
        isWinner: winnerSet ? winnerSet.has(player.id) : false,
        isLoser: loserMap ? loserMap.has(player.id) : false
      });
    });

    return Array.from(map.entries())
      .sort((a, b) => b[0] - a[0])
      .map(([layer, members]) => ({
        layer,
        players: members.sort((a, b) => a.name.localeCompare(b.name))
      }));
  }

  window.SPR = {
    api,
    showFeedback,
    capitalize,
    formatRoundMeta,
    extractDuelHighlights,
    summarizeStrategiesByLayer,
    groupPlayersByStage
  };
})();
