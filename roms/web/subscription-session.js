window.RayLinkSubscriptionSession = (() => {
  const urls = new Map();

  return Object.freeze({
    get(userId) {
      return urls.get(String(userId)) || "";
    },
    remember(userId, url) {
      urls.set(String(userId), String(url));
    },
    clear() {
      urls.clear();
    }
  });
})();
