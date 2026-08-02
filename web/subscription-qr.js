window.RayLinkSubscriptionQr = Object.freeze({
  render(container, value) {
    container.replaceChildren();
    container.classList.remove("unavailable");
    try {
      new QRCode(container, {
        text: value,
        width: 184,
        height: 184,
        colorDark: "#07100c",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.M
      });
      return true;
    } catch {
      container.classList.add("unavailable");
      container.textContent = "二维码暂不可用，请复制下方订阅链接";
      return false;
    }
  }
});
