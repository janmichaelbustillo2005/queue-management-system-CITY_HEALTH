import { defaultQueueSettings } from "../components/SettingsModal";
import { API_BASE_URL, request } from "./api";

export function mergeQueueSettings(raw = {}) {
  return { ...defaultQueueSettings, ...(raw || {}) };
}

export function loadLocalQueueSettings() {
  if (typeof window === "undefined") return { ...defaultQueueSettings };
  try {
    const raw = window.localStorage.getItem("queueSettings");
    if (!raw || !raw.trim()) return { ...defaultQueueSettings };
    return mergeQueueSettings(JSON.parse(raw));
  } catch (_e) {
    return { ...defaultQueueSettings };
  }
}

export function persistLocalQueueSettings(settings) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem("queueSettings", JSON.stringify(mergeQueueSettings(settings)));
}

export async function fetchQueueSettings() {
  const data = await request("/settings");
  if (data?.error) {
    return loadLocalQueueSettings();
  }
  const merged = mergeQueueSettings(data.settings || {});
  // Prefer live counter flags when provided separately by callers
  persistLocalQueueSettings(merged);
  return merged;
}

export function applyCounterAvailability(settings, counters = []) {
  const next = mergeQueueSettings(settings);
  for (const counter of counters) {
    if (counter.id_num === "Doctor 1") next.doctor1Online = counter.is_online !== false;
    if (counter.id_num === "Doctor 2") next.doctor2Online = counter.is_online !== false;
    if (counter.id_num === "Doctor 3") next.doctor3Online = counter.is_online !== false;
  }
  return next;
}

export async function saveQueueSettings(nextSettings) {
  const merged = mergeQueueSettings(nextSettings);
  persistLocalQueueSettings(merged);

  const data = await request("/settings", {
    method: "PUT",
    body: JSON.stringify(merged)
  });

  if (data?.error) {
    throw new Error(data.error);
  }

  const saved = mergeQueueSettings(data.settings || merged);
  persistLocalQueueSettings(saved);
  return saved;
}

export async function clearActiveQueues() {
  const data = await request("/queue/clear", { method: "POST" });
  if (data?.error) {
    throw new Error(data.error);
  }
  return data;
}

export async function exportQueueData(filters = {}) {
  const params = new URLSearchParams({
    status: filters.status || "",
    service: filters.service || "",
    dateFilter: filters.dateFilter || "today",
    format: filters.format || "csv"
  });
  const token = typeof window !== "undefined" ? localStorage.getItem("city_health_token") : null;
  const response = await fetch(`${API_BASE_URL}/queue/export?${params.toString()}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  if (!response.ok) {
    let message = "Failed to export data";
    try {
      const body = await response.json();
      message = body.message || body.error || message;
    } catch (_e) {
      // ignore
    }
    throw new Error(message);
  }
  const blob = await response.blob();
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `queue_data_${new Date().toISOString().split("T")[0]}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);

  // Track last export for backup reminder
  const current = loadLocalQueueSettings();
  const withExport = { ...current, lastExportAt: new Date().toISOString() };
  persistLocalQueueSettings(withExport);
  try {
    await request("/settings", {
      method: "PUT",
      body: JSON.stringify(withExport)
    });
  } catch (_e) {
    // local stamp is enough if API write fails
  }
}
