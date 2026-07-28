function clientUrl(universalUrl, format) {
  const separator = universalUrl.includes("?") ? "&" : "?";
  return `${universalUrl}${separator}format=${encodeURIComponent(format)}`;
}

function hydrateClientLinks(panel, url) {
  panel.querySelectorAll("[data-subscription-format]").forEach((link) => {
    const format = link.dataset.subscriptionFormat;
    const target = clientUrl(url, format);
    if (link.dataset.subscriptionImport === "egern") {
      link.href = `egern:/subscriptions/new?url=${encodeURIComponent(target)}`;
    } else if (link.dataset.subscriptionImport === "egern-profile") {
      link.href = `egern:/profiles/new?name=RayLink&url=${encodeURIComponent(target)}`;
    } else if (link.dataset.subscriptionImport === "clash") {
      link.href = `clash://install-config?url=${encodeURIComponent(target)}&name=RayLink`;
    } else {
      link.href = target;
    }
  });
}

function renderSubscriptionPanel(panel, url, qrRenderer) {
  const result = panel.querySelector("[data-user-subscription-result]");
  const input = panel.querySelector("#user-subscription-url");
  const qr = panel.querySelector("[data-user-subscription-qr]");
  input.value = url;
  result.hidden = false;
  hydrateClientLinks(panel, url);
  return qrRenderer(qr, url) === true;
}

window.RayLinkSubscriptionQuick = Object.freeze({
  reveal({ panel, userId, url, session, qrRenderer }) {
    session.remember(userId, url);
    return renderSubscriptionPanel(panel, url, qrRenderer);
  },

  hydrate({ scope, userId, session, qrRenderer }) {
    const url = session.get(userId);
    if (!url) return false;
    const panel = scope.querySelector("[data-user-subscription-panel]");
    if (!panel) return false;
    renderSubscriptionPanel(panel, url, qrRenderer);
    return true;
  }
});
