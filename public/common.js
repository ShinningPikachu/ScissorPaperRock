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

  function formatRole(player) {
    if (!player || typeof player !== 'object') {
      return '';
    }
    if (player.isBot) {
      return 'Bot';
    }
    return capitalize(player.role);
  }

  function formatRoundMeta(label, names) {
    if (!Array.isArray(names) || names.length === 0) {
      return '';
    }

    const list = names.join(', ');
    return `<span class="round-meta">${label}: ${list}</span>`;
  }

  function summarizeStrategiesByLayer(players) {
    const summary = new Map();
    const defaultMoves = ['rock', 'paper', 'scissors'];
    const totals = {
      rock: 0,
      paper: 0,
      scissors: 0,
      undecided: 0,
      total: 0
    };

    (Array.isArray(players) ? players : []).forEach((player) => {
      const layer =
        typeof player.layer === 'number' && Number.isFinite(player.layer)
          ? player.layer
          : 0;

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
      .sort((a, b) => b[0] - a[0])
      .map(([layer, counts]) => ({ layer, counts }));

    return { layers, totals };
  }

  window.SPR = {
    api,
    showFeedback,
    capitalize,
    formatRole,
    formatRoundMeta,
    summarizeStrategiesByLayer
  };
})();
