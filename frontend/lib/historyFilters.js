export function getManilaDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(now));
  const value = (type) => parts.find((part) => part.type === type).value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function getDefaultHistoryFilters(now = new Date()) {
  return {
    status: "", service: "", doctor: "", dateFilter: "range", date: "",
    startDate: getManilaDate(new Date(new Date(now).getTime() - 6 * 86400000)),
    endDate: getManilaDate(now)
  };
}
