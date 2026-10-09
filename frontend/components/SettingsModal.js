import React, { useEffect, useMemo, useRef, useState } from "react";

export const defaultQueueSettings = {
  autoRefresh: true,
  refreshInterval: 5,
  showCompleted: true,
  maxQueues: 20,
  soundNotifications: true,
  voiceAnnouncements: true,
  announceDoctorRoom: true,
  announceGapSeconds: 3,
  noShowWaitMinutes: 10,
  recallAttempts: 2,
  allowQueueReassignment: true,
  preventDuplicateRegistration: true,
  doctor1Online: true,
  doctor2Online: true,
  doctor3Online: true,
  autoBackupReminder: true,
  lastExportAt: null,
  exportStatus: "",
  exportService: "",
  exportDateFilter: "today",
  exportFormat: "csv"
};

const CATEGORIES = [
  { id: "queue", label: "Queue Configuration", icon: "fas fa-list", short: "Queue Configuration" },
  { id: "announce", label: "Notification and Announcement Settings", icon: "fas fa-bell", short: "Announcements" },
  { id: "rules", label: "Queue Rules and Patient Management", icon: "fas fa-clock", short: "Queue Rules" },
  { id: "data", label: "Data Management", icon: "fas fa-database", short: "Data Management" },
  { id: "security", label: "System Security and Maintenance", icon: "fas fa-shield-alt", short: "Security" }
];

const DEFAULT_CATEGORY = "queue";
let lastSelectedCategory = DEFAULT_CATEGORY;

function ToggleBadge({ enabled }) {
  return (
    <span
      className={`px-2.5 py-1 rounded-full text-[11px] font-bold ${
        enabled ? "bg-emerald-100 text-emerald-800" : "bg-gray-100 brand-text-muted"
      }`}
    >
      {enabled ? "Enabled" : "Disabled"}
    </span>
  );
}

function SettingRow({ title, description, children }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3 border-b brand-border last:border-b-0">
      <div className="min-w-0 pr-2">
        <div className="text-sm font-semibold brand-text">{title}</div>
        {description ? <p className="text-xs brand-text-muted mt-0.5 m-0">{description}</p> : null}
      </div>
      <div className="shrink-0 flex items-center">{children}</div>
    </div>
  );
}

function validateSettings(draft) {
  const errors = {};
  const interval = Number(draft.refreshInterval);
  if (!Number.isFinite(interval) || interval < 1 || interval > 60) {
    errors.refreshInterval = "Refresh interval must be between 1 and 60 seconds.";
  }
  const maxQueues = Number(draft.maxQueues);
  if (!Number.isFinite(maxQueues) || maxQueues < 5 || maxQueues > 100) {
    errors.maxQueues = "Max queues display must be between 5 and 100.";
  }
  const gap = Number(draft.announceGapSeconds);
  if (!Number.isFinite(gap) || gap < 0 || gap > 30) {
    errors.announceGapSeconds = "Announcement gap must be between 0 and 30 seconds.";
  }
  const noShow = Number(draft.noShowWaitMinutes);
  if (!Number.isFinite(noShow) || noShow < 1 || noShow > 120) {
    errors.noShowWaitMinutes = "No-show wait time must be between 1 and 120 minutes.";
  }
  const recalls = Number(draft.recallAttempts);
  if (!Number.isFinite(recalls) || recalls < 0 || recalls > 10) {
    errors.recallAttempts = "Recall attempts must be between 0 and 10.";
  }
  return errors;
}

export default function SettingsModal({
  isOpen,
  onClose,
  settings,
  setSettings,
  onSave,
  onClearAll,
  onExport
}) {
  const [category, setCategory] = useState(lastSelectedCategory);
  const [draft, setDraft] = useState(settings || defaultQueueSettings);
  const [baseline, setBaseline] = useState(settings || defaultQueueSettings);
  const [errors, setErrors] = useState({});
  const [notice, setNotice] = useState({ type: "", message: "" });
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const wasOpenRef = useRef(false);

  // Always keep the latest server-provided settings available, but only initialize
  // the editor when the modal is opened (not on every settings prop identity change).
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    if (!isOpen) {
      wasOpenRef.current = false;
      return;
    }

    if (wasOpenRef.current) {
      return;
    }

    wasOpenRef.current = true;
    const next = { ...defaultQueueSettings, ...(settingsRef.current || {}) };
    setDraft(next);
    setBaseline(next);
    setErrors({});
    setConfirmClear(false);

    if (next.autoBackupReminder) {
      const last = next.lastExportAt ? new Date(next.lastExportAt).getTime() : 0;
      const dayMs = 24 * 60 * 60 * 1000;
      if (!last || Date.now() - last > dayMs) {
        setNotice({
          type: "error",
          message: "Backup reminder: export queue data soon. Full database backups are managed in your Supabase project."
        });
      } else {
        setNotice({ type: "", message: "" });
      }
    } else {
      setNotice({ type: "", message: "" });
    }
  }, [isOpen]);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(baseline), [draft, baseline]);

  function handleCategorySelect(nextCategory) {
    lastSelectedCategory = nextCategory;
    setCategory(nextCategory);
  }

  function updateDraft(patch) {
    setDraft((prev) => ({ ...prev, ...patch }));
    setNotice({ type: "", message: "" });
  }

  function handleClose() {
    if (dirty && !window.confirm("You have unsaved changes. Discard them and close settings?")) {
      return;
    }
    onClose?.();
  }

  async function handleSave() {
    const nextErrors = validateSettings(draft);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      setNotice({ type: "error", message: "Please fix the highlighted settings before saving." });
      return;
    }
    try {
      const saved = (await onSave?.(draft)) || draft;
      const next = { ...defaultQueueSettings, ...(saved || draft) };
      setSettings?.(next);
      setDraft(next);
      setBaseline(next);
      setNotice({ type: "success", message: "Settings saved successfully." });
    } catch (err) {
      setNotice({ type: "error", message: err?.message || "Failed to save settings." });
    }
  }

  async function handleClearConfirm() {
    if (!onClearAll) return;
    setClearBusy(true);
    setNotice({ type: "", message: "" });
    try {
      await onClearAll({ archive: true });
      setConfirmClear(false);
      setNotice({
        type: "success",
        message: "Active queues were reset. Completed and cancelled records were preserved."
      });
    } catch (err) {
      setNotice({ type: "error", message: err?.message || "Failed to clear queues." });
    } finally {
      setClearBusy(false);
    }
  }

  async function handleExport() {
    if (!onExport) return;
    setExportBusy(true);
    setNotice({ type: "", message: "" });
    try {
      await onExport({
        status: draft.exportStatus || "",
        service: draft.exportService || "",
        dateFilter: draft.exportDateFilter || "today",
        format: draft.exportFormat || "csv"
      });
      setNotice({ type: "success", message: "Export started. Check your downloads." });
    } catch (err) {
      setNotice({ type: "error", message: err?.message || "Failed to export data." });
    } finally {
      setExportBusy(false);
    }
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center px-3 py-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[92vh] flex flex-col overflow-hidden">
        <div className="csu-gradient-bar text-white px-5 py-4">
          <h3 className="text-lg md:text-xl font-bold flex items-center m-0">
            <i className="fas fa-cog mr-3" />
            System Settings
          </h3>
          <p className="text-xs md:text-sm text-white/80 m-0 mt-1">
            Manage queue behavior, announcements, and system configuration.
          </p>
        </div>

        <div className="px-5 pt-4 pb-2 border-b brand-border">
          <div className="text-[10px] font-bold uppercase tracking-wider brand-text-muted mb-2">
            Settings Category
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            {CATEGORIES.map((item) => {
              const active = category === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleCategorySelect(item.id)}
                  className={`text-left rounded-lg border px-3 py-2.5 transition-colors ${
                    active
                      ? "brand-bg-subtle brand-border brand-text-primary"
                      : "bg-white brand-border brand-text brand-hover-subtle"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <i className={`${item.icon} text-sm ${active ? "brand-text-primary" : "brand-text-muted"}`} />
                    <span className="text-[11px] font-bold leading-tight">{item.short}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {notice.message ? (
            <div
              className={`mb-4 rounded-lg border px-3 py-2 text-sm ${
                notice.type === "success"
                  ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                  : "bg-red-50 border-red-200 text-red-700"
              }`}
            >
              {notice.message}
            </div>
          ) : null}

          {category === "queue" && (
            <section>
              <h4 className="font-bold brand-text text-base m-0 pb-2 border-b brand-border">
                Queue Configuration
              </h4>
              <SettingRow title="Auto-refresh Queue" description="Automatically update queue information.">
                <button
                  type="button"
                  onClick={() => updateDraft({ autoRefresh: !draft.autoRefresh })}
                  aria-pressed={draft.autoRefresh}
                >
                  <ToggleBadge enabled={!!draft.autoRefresh} />
                </button>
              </SettingRow>
              <SettingRow title="Refresh Interval" description="Time between queue refreshes.">
                <div className="flex flex-col items-end gap-1">
                  <div className="flex items-center gap-1">
                    <input
                      className={`w-16 px-2 py-1 border rounded text-sm ${errors.refreshInterval ? "border-red-400" : "brand-input"}`}
                      type="number"
                      min="1"
                      max="60"
                      value={draft.refreshInterval}
                      onChange={(e) => updateDraft({ refreshInterval: Number(e.target.value) })}
                    />
                    <span className="text-xs brand-text-muted">sec</span>
                  </div>
                  {errors.refreshInterval ? (
                    <span className="text-[10px] text-red-600 max-w-[160px] text-right">{errors.refreshInterval}</span>
                  ) : null}
                </div>
              </SettingRow>
              <SettingRow title="Show Completed Queues" description="Display completed records in the selected view.">
                <button
                  type="button"
                  onClick={() => updateDraft({ showCompleted: !draft.showCompleted })}
                >
                  <ToggleBadge enabled={!!draft.showCompleted} />
                </button>
              </SettingRow>
              <SettingRow title="Max Queues Display" description="Maximum records shown per page.">
                <div className="flex flex-col items-end gap-1">
                  <input
                    className={`w-16 px-2 py-1 border rounded text-sm ${errors.maxQueues ? "border-red-400" : "brand-input"}`}
                    type="number"
                    min="5"
                    max="100"
                    value={draft.maxQueues}
                    onChange={(e) => updateDraft({ maxQueues: Number(e.target.value) })}
                  />
                  {errors.maxQueues ? (
                    <span className="text-[10px] text-red-600 max-w-[160px] text-right">{errors.maxQueues}</span>
                  ) : null}
                </div>
              </SettingRow>
            </section>
          )}

          {category === "announce" && (
            <section>
              <h4 className="font-bold brand-text text-base m-0 pb-2 border-b brand-border">
                Notification and Announcement Settings
              </h4>
              <SettingRow title="Sound Notifications" description="Play alert sounds for queue events where supported.">
                <button type="button" onClick={() => updateDraft({ soundNotifications: !draft.soundNotifications })}>
                  <ToggleBadge enabled={!!draft.soundNotifications} />
                </button>
              </SettingRow>
              <SettingRow title="Voice Announcements" description="Allow the public display Voice Announcer when enabled by staff.">
                <button type="button" onClick={() => updateDraft({ voiceAnnouncements: !draft.voiceAnnouncements })}>
                  <ToggleBadge enabled={!!draft.voiceAnnouncements} />
                </button>
              </SettingRow>
              <SettingRow title="Announce Doctor & Room" description="Include doctor name and room in voice announcements.">
                <button type="button" onClick={() => updateDraft({ announceDoctorRoom: !draft.announceDoctorRoom })}>
                  <ToggleBadge enabled={!!draft.announceDoctorRoom} />
                </button>
              </SettingRow>
              <SettingRow title="Announcement Gap" description="Seconds to wait between queued voice announcements.">
                <div className="flex flex-col items-end gap-1">
                  <div className="flex items-center gap-1">
                    <input
                      className={`w-16 px-2 py-1 border rounded text-sm ${errors.announceGapSeconds ? "border-red-400" : "brand-input"}`}
                      type="number"
                      min="0"
                      max="30"
                      value={draft.announceGapSeconds}
                      onChange={(e) => updateDraft({ announceGapSeconds: Number(e.target.value) })}
                    />
                    <span className="text-xs brand-text-muted">sec</span>
                  </div>
                  {errors.announceGapSeconds ? (
                    <span className="text-[10px] text-red-600 max-w-[160px] text-right">{errors.announceGapSeconds}</span>
                  ) : null}
                </div>
              </SettingRow>
            </section>
          )}

          {category === "rules" && (
            <section>
              <h4 className="font-bold brand-text text-base m-0 pb-2 border-b brand-border">
                Queue Rules and Patient Management
              </h4>
              <SettingRow title="No-show Waiting Time" description="Suggested wait before marking a called patient as no-show.">
                <div className="flex flex-col items-end gap-1">
                  <div className="flex items-center gap-1">
                    <input
                      className={`w-16 px-2 py-1 border rounded text-sm ${errors.noShowWaitMinutes ? "border-red-400" : "brand-input"}`}
                      type="number"
                      min="1"
                      max="120"
                      value={draft.noShowWaitMinutes}
                      onChange={(e) => updateDraft({ noShowWaitMinutes: Number(e.target.value) })}
                    />
                    <span className="text-xs brand-text-muted">min</span>
                  </div>
                  {errors.noShowWaitMinutes ? (
                    <span className="text-[10px] text-red-600 max-w-[160px] text-right">{errors.noShowWaitMinutes}</span>
                  ) : null}
                </div>
              </SettingRow>
              <SettingRow title="Recall Attempts" description="How many times a patient may be recalled before escalation.">
                <div className="flex flex-col items-end gap-1">
                  <input
                    className={`w-16 px-2 py-1 border rounded text-sm ${errors.recallAttempts ? "border-red-400" : "brand-input"}`}
                    type="number"
                    min="0"
                    max="10"
                    value={draft.recallAttempts}
                    onChange={(e) => updateDraft({ recallAttempts: Number(e.target.value) })}
                  />
                  {errors.recallAttempts ? (
                    <span className="text-[10px] text-red-600 max-w-[160px] text-right">{errors.recallAttempts}</span>
                  ) : null}
                </div>
              </SettingRow>
              <SettingRow title="Queue Reassignment" description="Allow re-queueing patients to the bottom of their priority tier.">
                <button type="button" onClick={() => updateDraft({ allowQueueReassignment: !draft.allowQueueReassignment })}>
                  <ToggleBadge enabled={!!draft.allowQueueReassignment} />
                </button>
              </SettingRow>
              <div className="mt-3 rounded-lg border brand-border p-3">
                <div className="text-sm font-semibold brand-text mb-2">Doctor Availability</div>
                <p className="text-xs brand-text-muted mb-3 m-0">
                  Mark doctors online/offline. Offline doctors are skipped for automatic counter assignment.
                </p>
                {[
                  { key: "doctor1Online", label: "Doctor 1" },
                  { key: "doctor2Online", label: "Doctor 2" },
                  { key: "doctor3Online", label: "Doctor 3" }
                ].map((doc) => (
                  <div key={doc.key} className="flex items-center justify-between py-2 border-t brand-border first:border-t-0">
                    <span className="text-sm brand-text">{doc.label}</span>
                    <button type="button" onClick={() => updateDraft({ [doc.key]: !draft[doc.key] })}>
                      <ToggleBadge enabled={!!draft[doc.key]} />
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}

          {category === "data" && (
            <section>
              <h4 className="font-bold brand-text text-base m-0 pb-2 border-b brand-border">
                Data Management
              </h4>
              <div className="rounded-lg border brand-border p-4 mt-3">
                <div className="flex items-center gap-2 brand-text font-semibold mb-1">
                  <i className="fas fa-database brand-text-primary" />
                  Data Management
                </div>
                <p className="text-xs brand-text-muted m-0 mb-4">
                  Archive active queues safely and export transaction history with filters.
                </p>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
                  <label className="text-xs brand-text-muted">
                    Status
                    <select
                      className="mt-1 w-full px-2 py-1.5 border brand-input rounded text-sm"
                      value={draft.exportStatus}
                      onChange={(e) => updateDraft({ exportStatus: e.target.value })}
                    >
                      <option value="">All</option>
                      <option value="waiting">Waiting</option>
                      <option value="serving">Serving</option>
                      <option value="completed">Completed</option>
                      <option value="cancelled">Cancelled</option>
                    </select>
                  </label>
                  <label className="text-xs brand-text-muted">
                    Service
                    <select
                      className="mt-1 w-full px-2 py-1.5 border brand-input rounded text-sm"
                      value={draft.exportService}
                      onChange={(e) => updateDraft({ exportService: e.target.value })}
                    >
                      <option value="">All</option>
                      <option value="consultation">Consultation</option>
                      <option value="checkup">Check-up</option>
                      <option value="prenatal">Prenatal</option>
                      <option value="maternity">Maternity</option>
                      <option value="family_planning">Family Planning</option>
                    </select>
                  </label>
                  <label className="text-xs brand-text-muted">
                    Date range
                    <select
                      className="mt-1 w-full px-2 py-1.5 border brand-input rounded text-sm"
                      value={draft.exportDateFilter}
                      onChange={(e) => updateDraft({ exportDateFilter: e.target.value })}
                    >
                      <option value="today">Today</option>
                      <option value="week">This Week</option>
                      <option value="month">This Month</option>
                      <option value="">All Time</option>
                    </select>
                  </label>
                </div>

                <div className="flex flex-wrap gap-2 mb-4">
                  <label className="text-xs brand-text-muted flex items-center gap-2">
                    Format
                    <select
                      className="px-2 py-1.5 border brand-input rounded text-sm"
                      value={draft.exportFormat}
                      onChange={(e) => updateDraft({ exportFormat: e.target.value })}
                    >
                      <option value="csv">CSV</option>
                    </select>
                  </label>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <button
                    type="button"
                    disabled={exportBusy}
                    onClick={handleExport}
                    className="rounded-lg px-4 py-2.5 text-sm font-bold brand-button-subtle disabled:opacity-60"
                  >
                    {exportBusy ? "Exporting…" : "Export Data"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmClear(true)}
                    className="rounded-lg px-4 py-2.5 text-sm font-bold bg-red-100 text-red-800 hover:bg-red-200"
                  >
                    Reset Queue
                  </button>
                </div>
                <p className="text-[11px] brand-text-muted m-0 mt-3">
                  Reset archives active waiting/serving patients and clears doctor counters. Completed and cancelled history is kept.
                </p>
              </div>
            </section>
          )}

          {category === "security" && (
            <section>
              <h4 className="font-bold brand-text text-base m-0 pb-2 border-b brand-border">
                System Security and Maintenance
              </h4>
              <SettingRow
                title="Backup Reminder"
                description="Remind admins to export data regularly. Full database backups are managed in Supabase."
              >
                <button type="button" onClick={() => updateDraft({ autoBackupReminder: !draft.autoBackupReminder })}>
                  <ToggleBadge enabled={!!draft.autoBackupReminder} />
                </button>
              </SettingRow>
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
                <div className="font-semibold mb-1">Automatic database backup</div>
                <p className="text-xs m-0 text-amber-800/90">
                  This app does not run server-side DB backups directly. Use <strong>Export Data</strong> for transaction
                  archives, and configure backups in your Supabase project for full database recovery.
                </p>
              </div>
            </section>
          )}
        </div>

        <div className="brand-bg-subtle px-5 py-4 border-t brand-border flex flex-wrap items-center justify-between gap-3">
          <div className="text-[11px] brand-text-muted">
            {dirty ? "You have unsaved changes." : "All changes saved."}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleClose}
              className="px-4 py-2 bg-gray-200 brand-text rounded-lg hover:bg-gray-300 text-sm font-semibold"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="px-4 py-2 brand-button rounded-lg text-sm font-semibold"
            >
              Save Settings
            </button>
          </div>
        </div>
      </div>

      {confirmClear ? (
        <div className="fixed inset-0 z-[110] bg-black/50 flex items-center justify-center px-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md overflow-hidden">
            <div className="px-5 py-4 border-b brand-border">
              <h4 className="m-0 text-lg font-bold brand-text">Reset active queues?</h4>
            </div>
            <div className="px-5 py-4 text-sm brand-text-muted space-y-2">
              <p className="m-0">
                This will clear doctor counters and archive today&apos;s <strong>waiting</strong> and{" "}
                <strong>serving</strong> patients as cancelled with reason &quot;System queue reset&quot;.
              </p>
              <p className="m-0">
                Completed and previously cancelled records stay available in Super Admin records and exports.
              </p>
            </div>
            <div className="px-5 py-4 brand-bg-subtle flex justify-end gap-2">
              <button
                type="button"
                disabled={clearBusy}
                onClick={() => setConfirmClear(false)}
                className="px-4 py-2 rounded-lg bg-gray-200 brand-text text-sm font-semibold"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={clearBusy}
                onClick={handleClearConfirm}
                className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-700 disabled:opacity-60"
              >
                {clearBusy ? "Resetting…" : "Confirm Reset"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
