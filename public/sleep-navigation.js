const views = [
  "sleep",
  "today",
  "heart",
  "oxygen",
  "calories",
  "journal",
  "export",
  "settings",
  "more",
];
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
export function readWorkspaceLocation(location) {
  const [hashView, query = ""] = location.hash.slice(1).split("?");
  const view =
    location.pathname === "/settings"
      ? "settings"
      : views.includes(hashView)
        ? hashView
        : "sleep";
  const params = new URLSearchParams(
    location.pathname === "/settings" ? location.search : query,
  );
  let sources = {};
  try {
    sources = JSON.parse(params.get("sources") ?? "{}");
  } catch {}
  const sleepDate = params.get(view === "sleep" ? "date" : "sleepDate");
  return {
    view,
    date: datePattern.test(params.get("date") ?? "")
      ? params.get("date")
      : null,
    sleepSelection: {
      date: datePattern.test(sleepDate ?? "") ? sleepDate : null,
      sessionId: params.get(view === "sleep" ? "sessionId" : "sleepSessionId"),
      sources,
    },
  };
}
export function workspaceUrl(view, date, sleepSelection = {}) {
  const params = new URLSearchParams();
  if (view === "sleep") {
    if (sleepSelection.date) params.set("date", sleepSelection.date);
    if (sleepSelection.sessionId)
      params.set("sessionId", sleepSelection.sessionId);
  } else {
    if (date) params.set("date", date);
    if (sleepSelection.date) params.set("sleepDate", sleepSelection.date);
    if (sleepSelection.sessionId)
      params.set("sleepSessionId", sleepSelection.sessionId);
  }
  if (sleepSelection.sources && Object.keys(sleepSelection.sources).length)
    params.set("sources", JSON.stringify(sleepSelection.sources));
  return `${view === "settings" ? "/settings" : `/#${view}`}${params.size ? `?${params}` : ""}`;
}
