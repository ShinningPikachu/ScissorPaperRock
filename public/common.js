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

      let winningIds = [];
      if (Array.isArray(matchup.winnerIds) && matchup.winnerIds.length > 0) {
        winningIds = matchup.winnerIds.filter(
          (id) => typeof id === 'string' && id.length > 0
        );
      } else {
        const fallbackWinner =
          typeof matchup.winnerId === 'string' && matchup.winnerId.length > 0
            ? matchup.winnerId
            : outcome === 'a'
            ? matchup.aId
            : outcome === 'b'
            ? matchup.bId
            : outcome === 'bye'
            ? matchup.aId
            : null;
        if (fallbackWinner) {
          winningIds = [fallbackWinner];
        }
      }
      winningIds.forEach((id) => {
        if (id) {
          winners.add(id);
        }
      });

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

  function summarizeStrategiesByLayer(players) {
    const defaultMoves = ['rock', 'paper', 'scissors'];
    const totals = {
      rock: 0,
      paper: 0,
      scissors: 0,
      total: 0
    };

    (Array.isArray(players) ? players : []).forEach((player) => {
      if (
        !player ||
        player.role !== 'player' ||
        player.active === false ||
        player.status === 'eliminated'
      ) {
        return;
      }

      const move = typeof player.move === 'string' ? player.move.toLowerCase() : '';
      if (!defaultMoves.includes(move)) {
        return;
      }

      totals[move] += 1;
    });

    totals.total = totals.rock + totals.paper + totals.scissors;

    return { layers: [], totals };
  }

  function groupPlayersByStage(players, { duelHighlights, matchups } = {}) {
    const safePlayers = Array.isArray(players) ? players : [];
    const playerIndex = new Map();

    safePlayers.forEach((player) => {
      if (!player || player.role !== 'player') {
        return;
      }
      playerIndex.set(player.id, player);
    });

    const layerPlayers = new Map();

    const ensureLayer = (layer) => {
      const numericLayer = Number.isFinite(layer) ? layer : 0;
      if (!layerPlayers.has(numericLayer)) {
        layerPlayers.set(numericLayer, new Map());
      }
      return layerPlayers.get(numericLayer);
    };

    const createEntry = (player, fallbackName) => ({
      id: player?.id || null,
      name: player?.name || fallbackName || 'Unknown',
      active: player ? player.active !== false : true,
      status: player ? player.status : 'waiting',
      isWinner: false,
      isLoser: false
    });

    const getOrCreateEntry = (layer, playerId, fallbackName) => {
      if (!playerId) {
        return null;
      }
      const roster = ensureLayer(layer);
      let entry = roster.get(playerId);
      if (!entry) {
        const base = playerIndex.get(playerId) || null;
        entry = createEntry(base, fallbackName);
        roster.set(playerId, entry);
      } else if (fallbackName && entry.name === 'Unknown') {
        entry.name = fallbackName;
      }
      return entry;
    };

    const removeFromAllLayers = (playerId) => {
      layerPlayers.forEach((roster) => {
        roster.delete(playerId);
      });
    };

    safePlayers.forEach((player) => {
      if (!player || player.role !== 'player' || player.status === 'eliminated') {
        return;
      }

      const baseLayer =
        typeof player.layer === 'number' && Number.isFinite(player.layer)
          ? player.layer
          : 0;

      const entry = getOrCreateEntry(baseLayer, player.id, player.name);
      if (entry) {
        entry.active = player.active !== false;
        entry.status = player.status;
      }
    });

    const matchupMap = new Map();
    (Array.isArray(matchups) ? matchups : []).forEach((matchup) => {
      if (!matchup || typeof matchup !== 'object') {
        return;
      }
      const stageValue =
        typeof matchup.stage === 'number' && Number.isFinite(matchup.stage)
          ? matchup.stage
          : 0;
      if (!matchupMap.has(stageValue)) {
        matchupMap.set(stageValue, []);
      }
      const entries = matchupMap.get(stageValue);
      const fallbackAName =
        typeof matchup.aName === 'string' && matchup.aName.length > 0
          ? matchup.aName
          : matchup.aId
          ? 'Player A'
          : 'Awaiting opponent';
      const fallbackBName =
        typeof matchup.bName === 'string' && matchup.bName.length > 0
          ? matchup.bName
          : matchup.bId
          ? 'Player B'
          : 'Awaiting opponent';
      const snapshot = {
        id:
          typeof matchup.id === 'string'
            ? matchup.id
            : `duel-${stageValue}-${entries.length + 1}`,
        stage: stageValue,
        aId: typeof matchup.aId === 'string' ? matchup.aId : null,
        aName: fallbackAName,
        bId: typeof matchup.bId === 'string' ? matchup.bId : null,
        bName: fallbackBName,
        result: typeof matchup.result === 'string' ? matchup.result : 'pending',
        winnerId: typeof matchup.winnerId === 'string' ? matchup.winnerId : null,
        loserId: typeof matchup.loserId === 'string' ? matchup.loserId : null,
        loserNextLayer:
          typeof matchup.loserNextLayer === 'number' && Number.isFinite(matchup.loserNextLayer)
            ? matchup.loserNextLayer
            : null,
        revealed: Boolean(matchup.revealed)
      };
      entries.push(snapshot);

      const existingRoster = layerPlayers.get(stageValue);
      const canExposeParticipant = (playerId) => {
        if (!playerId) {
          return false;
        }
        if (stageValue >= 0) {
          return true;
        }
        if (snapshot.revealed) {
          return true;
        }
        return Boolean(existingRoster && existingRoster.has(playerId));
      };

      const fighterA = canExposeParticipant(snapshot.aId)
        ? getOrCreateEntry(stageValue, snapshot.aId, snapshot.aName)
        : null;
      const fighterB = canExposeParticipant(snapshot.bId)
        ? getOrCreateEntry(stageValue, snapshot.bId, snapshot.bName)
        : null;

      if (!snapshot.revealed) {
        return;
      }

      if (snapshot.result === 'a') {
        if (fighterA) {
          fighterA.isWinner = true;
        }
        if (snapshot.bId) {
          removeFromAllLayers(snapshot.bId);
          const targetLayer =
            typeof snapshot.loserNextLayer === 'number' && Number.isFinite(snapshot.loserNextLayer)
              ? snapshot.loserNextLayer
              : stageValue - 1;
          const demoted = getOrCreateEntry(targetLayer, snapshot.bId, snapshot.bName);
          if (demoted) {
            demoted.isLoser = true;
            const base = playerIndex.get(snapshot.bId);
            if (base) {
              demoted.active = base.active !== false;
              demoted.status = base.status;
            }
          }
        }
      } else if (snapshot.result === 'b') {
        if (fighterB) {
          fighterB.isWinner = true;
        }
        if (snapshot.aId) {
          removeFromAllLayers(snapshot.aId);
          const targetLayer =
            typeof snapshot.loserNextLayer === 'number' && Number.isFinite(snapshot.loserNextLayer)
              ? snapshot.loserNextLayer
              : stageValue - 1;
          const demoted = getOrCreateEntry(targetLayer, snapshot.aId, snapshot.aName);
          if (demoted) {
            demoted.isLoser = true;
            const base = playerIndex.get(snapshot.aId);
            if (base) {
              demoted.active = base.active !== false;
              demoted.status = base.status;
            }
          }
        }
      } else if (snapshot.result === 'tie') {
        if (fighterA) {
          fighterA.isLoser = false;
        }
        if (fighterB) {
          fighterB.isLoser = false;
        }
      } else if (snapshot.result === 'bye') {
        if (fighterA) {
          fighterA.isWinner = true;
        }
      }
    });

    const winnerSet =
      duelHighlights && duelHighlights.winners instanceof Set ? duelHighlights.winners : null;
    const loserMap =
      duelHighlights && duelHighlights.losers instanceof Map ? duelHighlights.losers : null;

    if (winnerSet || loserMap) {
      layerPlayers.forEach((roster, layer) => {
        roster.forEach((entry, playerId) => {
          if (winnerSet && winnerSet.has(playerId)) {
            entry.isWinner = true;
          }
          if (loserMap && loserMap.has(playerId)) {
            entry.isLoser = true;
            const desiredLayer = loserMap.get(playerId);
            if (Number.isFinite(desiredLayer) && desiredLayer !== layer) {
              removeFromAllLayers(playerId);
              const reassigned = getOrCreateEntry(desiredLayer, playerId, entry.name);
              if (reassigned) {
                reassigned.isLoser = true;
                reassigned.active = entry.active;
                reassigned.status = entry.status;
              }
            }
          }
        });
      });
    }

    const layerKeys = new Set([...layerPlayers.keys(), ...matchupMap.keys()]);

    return Array.from(layerKeys)
      .sort((a, b) => Number(b) - Number(a))
      .map((layer) => {
        const roster = layerPlayers.get(layer);
        const playersForLayer = roster
          ? Array.from(roster.values()).sort((a, b) => a.name.localeCompare(b.name))
          : [];
        const layerMatchups = matchupMap.get(layer) || [];
        return {
          layer,
          players: playersForLayer,
          matchups: layerMatchups
        };
      })
      .filter((entry) => entry.players.length > 0);
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
