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

  window.SPR = {
    api,
    showFeedback,
    capitalize,
    formatRoundMeta
  };
})();
