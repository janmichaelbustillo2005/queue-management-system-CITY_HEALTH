// Request URLs as written to the server log. Query values are replaced because some carry
// patient data (Records ?search= names and identifiers, ?account=, ?visit=, geocode ?q=
// addresses) and logs outlive requests. Parameter names stay, so a line still shows which
// filters a request used; the path and method are unchanged.
function redactQueryValues(url) {
  const text = String(url ?? "");
  const start = text.indexOf("?");
  if (start === -1) return text;
  const query = text.slice(start + 1).split("#")[0];
  const names = query.split("&").filter(Boolean).map((part) => `${part.split("=")[0]}=[redacted]`);
  return `${text.slice(0, start)}${names.length ? `?${names.join("&")}` : ""}`;
}

module.exports = { redactQueryValues };
