function formatSubscriptionClientUrl(universalUrl, format) {
  if (format === "loon") return universalUrl;
  const separator = universalUrl.includes("?") ? "&" : "?";
  return `${universalUrl}${separator}format=${encodeURIComponent(format)}`;
}

window.RayLinkSubscriptionClientUrl = Object.freeze({
  forFormat: formatSubscriptionClientUrl
});
