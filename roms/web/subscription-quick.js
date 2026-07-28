function renderSubscriptionPanel(panel, url, qrRenderer) {
  const result = panel.querySelector("[data-user-subscription-result]");
  const input = panel.querySelector("#user-subscription-url");
  const qr = panel.querySelector("[data-user-subscription-qr]");
  input.value = url;
  result.hidden = false;
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
    return renderSubscriptionPanel(panel, url, qrRenderer);
  }
});
