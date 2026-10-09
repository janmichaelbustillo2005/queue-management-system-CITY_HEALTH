import { useEffect, useRef, useState } from "react";
import { request } from "../lib/api";
import { defaultQueueSettings } from "../components/SettingsModal";
import { mergeQueueSettings, persistLocalQueueSettings } from "../lib/queueSettings";
import SystemLogo from "../components/SystemLogo";

const ANNOUNCE_GAP_MS_DEFAULT = 3000;
const DISPLAY_POLL_MS = 1500;

let runtimeQueueSettings = { ...defaultQueueSettings };

function applyRuntimeSettings(raw) {
  runtimeQueueSettings = mergeQueueSettings(raw || {});
  try {
    persistLocalQueueSettings(runtimeQueueSettings);
  } catch (_e) {
    // ignore
  }
  return runtimeQueueSettings;
}

function getStoredAnnounceGapMs() {
  const gapSec = Number(runtimeQueueSettings?.announceGapSeconds);
  if (!Number.isFinite(gapSec) || gapSec < 0) return ANNOUNCE_GAP_MS_DEFAULT;
  return Math.round(gapSec * 1000);
}

function voiceAnnouncementsAllowed() {
  return runtimeQueueSettings?.voiceAnnouncements !== false;
}

function soundNotificationsAllowed() {
  return runtimeQueueSettings?.soundNotifications !== false;
}

const DOCTOR_INFO_MAP = {
  "Doctor 1": { specialty: "General Practitioner", badge: "GP", room: "Room 1" },
  "Doctor 2": { specialty: "Prenatal & Maternity", badge: "OB", room: "Room 2" },
  "Doctor 3": { specialty: "Family Planning", badge: "FP", room: "Room 3" }
};

function getAnnouncementKey(patient) {
  if (!patient?.id || !patient.accepted_at) return null;
  return `${patient.id}:${patient.accepted_at}`;
}

function resolveDoctorName(patient) {
  const raw = patient?.counter_name || patient?.counter_id || "";
  if (typeof raw === "string" && DOCTOR_INFO_MAP[raw]) return raw;
  if (typeof raw === "string" && raw.startsWith("Doctor")) return raw;
  return typeof raw === "string" && raw && Number.isNaN(Number(raw)) ? raw : "Doctor";
}

function resolveRoom(doctorName) {
  return DOCTOR_INFO_MAP[doctorName]?.room || "";
}

function collectCallCandidates(displayData) {
  const byKey = new Map();

  for (const patient of displayData?.recent_accepted || []) {
    const key = getAnnouncementKey(patient);
    if (key && !byKey.has(key)) byKey.set(key, patient);
  }

  return Array.from(byKey.values());
}

function pickVoice(voices) {
  if (!voices?.length) return null;
  return (
    voices.find((v) => /google/i.test(v.name) && /^en(-|_|$)/i.test(v.lang)) ||
    voices.find((v) => /zira/i.test(v.name)) ||
    voices.find((v) => /david/i.test(v.name)) ||
    voices.find((v) => /microsoft/i.test(v.name) && /^en(-|_|$)/i.test(v.lang)) ||
    voices.find((v) => /^en(-|_|$)/i.test(v.lang)) ||
    voices[0]
  );
}

export default function QueueDisplayPage() {
  const [time, setTime] = useState(new Date());
  const [mounted, setMounted] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState("");
  const [display, setDisplay] = useState({
    settings: {
      department_name: "CHO & Family Planning Center Cabadbaran City",
      welcome_message: "Welcome to City Health Queuing System"
    },
    all_serving: [],
    counters: [],
    now_serving: null,
    next_in_line: null,
    waiting_count: 0,
    recent_called: [],
    waiting_queue: []
  });

  const [apiError, setApiError] = useState(null);

  const announcementQueueRef = useRef([]);
  const announcedKeysRef = useRef(new Set());
  const isProcessingRef = useRef(false);
  const voiceEnabledRef = useRef(false);
  const seededRef = useRef(false);
  const audioCtxRef = useRef(null);
  const displayRef = useRef(display);
  const preferredVoiceRef = useRef(null);

  useEffect(() => {
    displayRef.current = display;
  }, [display]);

  useEffect(() => {
    setMounted(true);
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Preload voices when available
  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return undefined;
    const cacheVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      preferredVoiceRef.current = pickVoice(voices);
    };
    cacheVoices();
    window.speechSynthesis.addEventListener("voiceschanged", cacheVoices);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", cacheVoices);
  }, []);

  useEffect(() => {
    loadDisplay();
    const interval = setInterval(loadDisplay, DISPLAY_POLL_MS);
    return () => clearInterval(interval);
  }, []);

  // Keep ref in sync with React state (survives Fast Refresh / remounts)
  useEffect(() => {
    voiceEnabledRef.current = voiceEnabled;
    if (!voiceEnabled) {
      seededRef.current = false;
      announcementQueueRef.current = [];
      announcedKeysRef.current = new Set();
      isProcessingRef.current = false;
      return;
    }
    // If state says enabled but we lost seed (HMR), re-seed from current display only
    if (!seededRef.current) {
      seedKnownCalls(displayRef.current);
      setVoiceStatus("Listening for doctor calls…");
    }
  }, [voiceEnabled]);

  // Chrome: speechSynthesis can pause itself; keep it alive while voice is on
  useEffect(() => {
    if (!voiceEnabled || typeof window === "undefined" || !window.speechSynthesis) return undefined;
    const keepAlive = setInterval(() => {
      try {
        if (window.speechSynthesis.speaking && window.speechSynthesis.paused) {
          window.speechSynthesis.resume();
        }
      } catch (_e) {
        // ignore
      }
    }, 200);
    return () => clearInterval(keepAlive);
  }, [voiceEnabled]);

  function seedKnownCalls(displayData) {
    const candidates = collectCallCandidates(displayData);
    const nextKeys = new Set();
    candidates.forEach((patient) => {
      const key = getAnnouncementKey(patient);
      if (key) nextKeys.add(key);
    });
    announcedKeysRef.current = nextKeys;
    seededRef.current = true;
  }

  function unlockAudioFromUserGesture() {
    if (typeof window === "undefined") return;

    // Unlock Web Audio (bell) inside the click gesture with an audible chime
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) {
        if (!audioCtxRef.current) audioCtxRef.current = new Ctx();
        if (audioCtxRef.current.state === "suspended") {
          audioCtxRef.current.resume().catch(() => {});
        }
        const ctx = audioCtxRef.current;
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(880, now);
        gain.gain.setValueAtTime(0.35, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.35);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.35);
      }
    } catch (_e) {
      // ignore
    }

    // Unlock SpeechSynthesis with a real audible phrase (empty utterances often fail)
    if (window.speechSynthesis) {
      try {
        window.speechSynthesis.cancel();
        const voices = window.speechSynthesis.getVoices();
        preferredVoiceRef.current = pickVoice(voices) || preferredVoiceRef.current;

        const unlock = new SpeechSynthesisUtterance("Voice announcer enabled");
        unlock.lang = "en-US";
        unlock.rate = 1;
        unlock.pitch = 1;
        unlock.volume = 1;
        if (preferredVoiceRef.current) unlock.voice = preferredVoiceRef.current;
        window.speechSynthesis.speak(unlock);
      } catch (err) {
        console.error("Failed to unlock speechSynthesis:", err);
      }
    }
  }

  function enableVoiceAnnouncer() {
    if (!voiceAnnouncementsAllowed()) {
      setVoiceStatus("Voice announcements are disabled in System Settings.");
      return;
    }
    // Seed BEFORE flipping the enabled ref so an in-flight poll cannot
    // mark brand-new calls as "already known" without announcing them.
    seedKnownCalls(displayRef.current);
    unlockAudioFromUserGesture();
    voiceEnabledRef.current = true;
    setVoiceEnabled(true);
    setVoiceStatus("Listening for doctor calls…");
    setIsSpeaking(false);
  }

  function disableVoiceAnnouncer() {
    voiceEnabledRef.current = false;
    seededRef.current = false;
    announcementQueueRef.current = [];
    announcedKeysRef.current = new Set();
    isProcessingRef.current = false;
    setVoiceEnabled(false);
    setVoiceStatus("");
    setIsSpeaking(false);
    if (typeof window !== "undefined" && window.speechSynthesis) {
      try {
        window.speechSynthesis.cancel();
      } catch (_e) {
        // ignore
      }
    }
  }

  function enqueueNewCalls(candidatePatients) {
    if (!voiceEnabledRef.current || !seededRef.current) return;

    const newcomers = [];
    for (const patient of candidatePatients || []) {
      const key = getAnnouncementKey(patient);
      if (!key) continue;
      if (announcedKeysRef.current.has(key)) continue;

      announcedKeysRef.current.add(key);
      const doctorName = resolveDoctorName(patient);
      newcomers.push({
        key,
        patient: {
          id: patient.id,
          queue_number: patient.queue_number,
          id_num: patient.id_num,
          counter_name: doctorName,
          room: resolveRoom(doctorName),
          called_at: patient.called_at
        },
        calledAtMs: new Date(patient.accepted_at).getTime()
      });
    }

    if (!newcomers.length) {
      processAnnouncementQueue();
      return;
    }

    newcomers.sort((a, b) => a.calledAtMs - b.calledAtMs);
    announcementQueueRef.current.push(...newcomers);
    announcementQueueRef.current.sort((a, b) => a.calledAtMs - b.calledAtMs);
    setVoiceStatus(`Queued: ${announcementQueueRef.current.length} announcement(s)`);
    processAnnouncementQueue();
  }

  async function processAnnouncementQueue() {
    if (isProcessingRef.current) return;
    if (!voiceEnabledRef.current) return;
    if (announcementQueueRef.current.length === 0) return;

    isProcessingRef.current = true;

    while (voiceEnabledRef.current && announcementQueueRef.current.length > 0) {
      const next = announcementQueueRef.current.shift();
      if (!next?.patient) continue;

      try {
        await speakPatientAnnouncement(next.patient);
      } catch (err) {
        console.error("Announcement failed:", err);
        setVoiceStatus(`Announcement error: ${err.message || "playback failed"}`);
      }

      if (voiceEnabledRef.current && announcementQueueRef.current.length > 0) {
        await delay(getStoredAnnounceGapMs());
      }
    }

    isProcessingRef.current = false;
    if (voiceEnabledRef.current) {
      setVoiceStatus(
        announcementQueueRef.current.length
          ? `Queued: ${announcementQueueRef.current.length} announcement(s)`
          : "Listening for doctor calls…"
      );
    }

    if (voiceEnabledRef.current && announcementQueueRef.current.length > 0) {
      processAnnouncementQueue();
    }
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function playNotificationBell() {
    return new Promise((resolve) => {
      if (!soundNotificationsAllowed()) {
        resolve();
        return;
      }
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) {
          resolve();
          return;
        }
        if (!audioCtxRef.current) audioCtxRef.current = new Ctx();
        const ctx = audioCtxRef.current;
        if (ctx.state === "suspended") {
          ctx.resume().catch(() => {});
        }
        const now = ctx.currentTime;

        const osc1 = ctx.createOscillator();
        const gain1 = ctx.createGain();
        osc1.type = "sine";
        osc1.frequency.setValueAtTime(880, now);
        osc1.frequency.setValueAtTime(1100, now + 0.12);
        gain1.gain.setValueAtTime(0.5, now);
        gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.4);
        osc1.connect(gain1).connect(ctx.destination);
        osc1.start(now);
        osc1.stop(now + 0.4);

        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.type = "sine";
        osc2.frequency.setValueAtTime(660, now + 0.25);
        osc2.frequency.setValueAtTime(880, now + 0.37);
        gain2.gain.setValueAtTime(0, now);
        gain2.gain.setValueAtTime(0.5, now + 0.25);
        gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.65);
        osc2.connect(gain2).connect(ctx.destination);
        osc2.start(now + 0.25);
        osc2.stop(now + 0.65);

        setTimeout(resolve, 700);
      } catch (e) {
        resolve();
      }
    });
  }

  function speakText(text, { cancelPending = false } = {}) {
    return new Promise((resolve, reject) => {
      if (typeof window === "undefined" || !window.speechSynthesis) {
        reject(new Error("Speech synthesis is not supported in this browser"));
        return;
      }

      let settled = false;
      let safetyTimer = null;
      let resumeTimer = null;

      const finish = (err) => {
        if (settled) return;
        settled = true;
        if (safetyTimer) clearTimeout(safetyTimer);
        if (resumeTimer) clearInterval(resumeTimer);
        if (err) reject(err);
        else resolve();
      };

      try {
        if (cancelPending) {
          window.speechSynthesis.cancel();
        } else if (window.speechSynthesis.paused) {
          window.speechSynthesis.resume();
        }

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = "en-US";
        const voice = preferredVoiceRef.current || pickVoice(window.speechSynthesis.getVoices());
        if (voice) {
          preferredVoiceRef.current = voice;
          utterance.voice = voice;
          if (voice.lang) utterance.lang = voice.lang;
        }
        utterance.rate = 0.9;
        utterance.pitch = 1.0;
        utterance.volume = 1.0;

        const estimatedMs = Math.min(35000, Math.max(8000, text.length * 120 + 2000));
        safetyTimer = setTimeout(() => finish(), estimatedMs);

        // Periodic resume — Chrome sometimes pauses mid-utterance
        resumeTimer = setInterval(() => {
          try {
            if (window.speechSynthesis.paused) window.speechSynthesis.resume();
          } catch (_e) {
            // ignore
          }
        }, 250);

        utterance.onend = () => finish();
        utterance.onerror = (event) => {
          const errName = event?.error || "speech_error";
          // "interrupted" / "canceled" can happen on disable — treat as soft end
          if (errName === "interrupted" || errName === "canceled") {
            finish();
            return;
          }
          finish(new Error(`Speech error: ${errName}`));
        };

        window.speechSynthesis.speak(utterance);

        // Nudge engines that start paused
        setTimeout(() => {
          try {
            if (window.speechSynthesis.paused) window.speechSynthesis.resume();
          } catch (_e) {
            // ignore
          }
        }, 40);
      } catch (err) {
        finish(err);
      }
    });
  }

  async function speakPatientAnnouncement(patient) {
    setIsSpeaking(true);
    setVoiceStatus(`Announcing ${patient.queue_number || "patient"}…`);

    try {
      await playNotificationBell();
    } catch (_e) {
      // continue even if bell fails
    }

    if (!voiceEnabledRef.current) {
      setIsSpeaking(false);
      return;
    }

    const queueNumber = patient.queue_number || "";
    const name = patient.id_num || "Patient";
    const doctorName = patient.counter_name || "Doctor";
    const room = patient.room || resolveRoom(doctorName);
    const includeRoom = runtimeQueueSettings?.announceDoctorRoom !== false;
    const destination = includeRoom && room ? `${doctorName}, ${room}` : doctorName;
    const spokenQueue = String(queueNumber).split("").join(" ").replace(/-/g, " ");
    const text = `Now calling queue number ${spokenQueue}, ${name}, please proceed to ${destination}.`;

    try {
      // Clear any leftover unlock utterance so the patient call speaks cleanly
      await speakText(text, { cancelPending: true });
    } finally {
      setIsSpeaking(false);
    }
  }

  const matchesDoctor = (serviceType, assignedServices) => {
    if (!serviceType || !assignedServices) return false;
    if (assignedServices.includes(serviceType)) return true;

    const serviceToCategory = {
      consultation: "GP", checkup: "GP", laboratory: "GP", dental: "GP",
      prenatal: "OB", maternity: "OB", obgyne: "OB",
      family_planning: "FP"
    };

    const patientCategory = serviceToCategory[serviceType];
    const doctorCategories = assignedServices.map(s => serviceToCategory[s]).filter(Boolean);

    return patientCategory && doctorCategories.includes(patientCategory);
  };

  async function loadDisplay() {
    try {
      const data = await request("/display");

      if (data.error) {
        setApiError(data.error);
        return;
      }

      setApiError(null);
      setDisplay(data);
      displayRef.current = data;

      if (data.queue_settings) {
        applyRuntimeSettings(data.queue_settings);
        if (!voiceAnnouncementsAllowed() && voiceEnabledRef.current) {
          voiceEnabledRef.current = false;
          setVoiceEnabled(false);
          setVoiceStatus("Voice announcements disabled in System Settings");
        }
      }

      // Only enqueue when voice is active AND already seeded from the enable click.
      // Never seed from poll data — that can swallow brand-new calls without announcing.
      if (voiceEnabledRef.current && seededRef.current && voiceAnnouncementsAllowed()) {
        enqueueNewCalls(collectCallCandidates(data));
      }
    } catch (_error) {
      setApiError("Cannot connect to server");
    }
  }

  const formatTime = (date) => {
    return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });
  };

  const formatDate = (date) => {
    return date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  };

  const doctorInfoMap = DOCTOR_INFO_MAP;
  const allServing = display?.all_serving || [];
  const waitingCount = display?.waiting_count ?? 0;
  const countersFromApi = display?.counters || [];
  const allCounters = countersFromApi.length > 0 ? countersFromApi.slice(0, 3) : [
    { id: 1, id_num: "Doctor 1" },
    { id: 2, id_num: "Doctor 2" },
    { id: 3, id_num: "Doctor 3" }
  ];

  return (
    <div className="layout-shell display-page min-h-screen flex flex-col font-sans">
      <header className="queue-display-header px-6 py-4 flex items-center justify-between border-b border-[var(--display-border)] bg-[var(--display-card-header)]">
        <div className="queue-display-brand flex items-center gap-4">
          <SystemLogo variant="display" />
          <div className="queue-display-title">
            <h1 className="text-xl md:text-2xl font-bold text-white tracking-tight">
              {display?.settings?.department_name || "CHO & Family Planning Center"} Smart Queuing System
            </h1>
            <p className="text-xs md:text-sm text-white/70 font-bold uppercase tracking-widest">
              CHO CABADBARAN CITY
            </p>
          </div>
        </div>

        <div className="queue-display-controls flex items-center">
          <div className="flex flex-col items-end gap-1">
            <button
              type="button"
              onClick={() => {
                if (voiceEnabled) disableVoiceAnnouncer();
                else enableVoiceAnnouncer();
              }}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold uppercase transition-all ${
                voiceEnabled
                  ? "brand-button text-white shadow-md"
                  : "bg-white/5 text-white/70 border border-white/10 hover:bg-white/10"
              }`}
            >
              <i className={`fas ${voiceEnabled ? "fa-volume-up" : "fa-volume-mute"}`} />
              {voiceEnabled ? (isSpeaking ? "Announcing…" : "Voice Enabled") : "Voice Disabled"}
            </button>
            {voiceEnabled && voiceStatus ? (
              <span className="text-[9px] text-white/60 font-bold uppercase tracking-wider max-w-[220px] text-right truncate">
                {voiceStatus}
              </span>
            ) : null}
          </div>
          <div className="text-right min-w-[140px]">
            {mounted ? (
              <>
                <div className="text-2xl md:text-3xl font-mono font-bold text-white leading-none">
                  {formatTime(time)}
                </div>
                <div className="text-[10px] md:text-xs text-white/60 uppercase tracking-tighter mt-1 font-bold">
                  {formatDate(time)}
                </div>
              </>
            ) : (
              <div className="h-10" />
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 container mx-auto px-4 py-6 max-w-7xl">
        {apiError && (
          <div className="mb-4 text-center text-red-400 font-bold bg-black/40 py-2 rounded-lg border border-red-400/50">
            ⚠️ {apiError}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-10">
          {allCounters.map((counter) => {
            const servingPatient = allServing.find((s) =>
              s.counter_id === counter.id ||
              s.counter_id === counter.id_num ||
              s.counter_name === counter.id_num
            );
            const info = doctorInfoMap[counter.id_num] || { specialty: "Medical Professional", badge: "MD", room: "TBA" };
            const isAvailable = !servingPatient;
            const counterServices = counter.service_types || [];
            const waitingForCounter = display?.waiting_queue?.filter((p) =>
              matchesDoctor(p.service_type, counterServices)
            ).length || 0;
            const nextForCounter = display?.waiting_queue?.find((p) =>
              matchesDoctor(p.service_type, counterServices)
            );

            return (
              <div key={counter.id} className="display-card overflow-hidden border border-[var(--display-border)] flex flex-col shadow-2xl">
                <div className="bg-[var(--display-card-header)] px-5 py-4 flex items-center justify-between border-b border-[var(--display-border)]">
                  <div>
                    <h3 className="text-lg font-bold text-white">{counter.id_num}</h3>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="bg-[var(--brand-primary)] text-white text-[10px] font-black px-2 py-0.5 rounded shadow-sm">
                      {info.badge}
                    </span>
                    <span className="text-[10px] text-white/60 font-black uppercase">{info.room}</span>
                  </div>
                </div>

                <div className="flex-1 flex flex-col items-center justify-center p-8 bg-[var(--display-inner-bg)]">
                  <p className="text-[10px] text-white/60 uppercase font-black tracking-[0.3em] mb-4">Now Serving</p>
                  <div className="w-full bg-[var(--display-card-header)] rounded-2xl py-8 mb-6 border border-[var(--display-border)] flex items-center justify-center min-h-[140px] shadow-inner">
                    {servingPatient ? (
                      <div className="text-5xl md:text-7xl font-black queue-number text-[var(--brand-gold-bright)] tracking-tighter flip-in">
                        {servingPatient.queue_number}
                      </div>
                    ) : (
                      <div className="text-5xl md:text-7xl font-black text-white/5 tracking-widest">—</div>
                    )}
                  </div>
                  <div className="text-center h-12">
                    {servingPatient ? (
                      <>
                        <h4 className="text-lg font-bold text-white leading-tight truncate max-w-[240px]">
                          {servingPatient.id_num}
                        </h4>
                        <p className="text-[10px] text-white/60 uppercase font-black tracking-widest mt-1">
                          {servingPatient.service_type}
                        </p>
                      </>
                    ) : (
                      <p className="text-xs text-white/60 font-black uppercase tracking-widest">No patient being served</p>
                    )}
                  </div>
                </div>

                <div className="px-5 pb-6 flex justify-center bg-[var(--display-inner-bg)]">
                  <div className={`
                    flex items-center gap-2 px-6 py-2 rounded-full text-[10px] font-black uppercase tracking-widest border
                    ${isAvailable
                      ? "bg-[var(--display-card-bg)] text-[var(--display-positive)] border-[var(--display-border)]"
                      : "bg-[var(--brand-primary)] text-white border-transparent shadow-lg"}
                  `}>
                    <div className={`w-2 h-2 rounded-full ${isAvailable ? "bg-[var(--display-positive)]" : "bg-white"} animate-pulse`} />
                    {isAvailable ? "Available" : "Serving"}
                  </div>
                </div>

                <div className="bg-[var(--display-card-header)] px-5 py-3 flex items-center justify-between text-[10px] font-bold border-t border-[var(--display-border)]">
                  <div className="flex items-center gap-2">
                    <span className="text-white/60 uppercase tracking-wider">Next</span>
                    <span className="text-[var(--display-positive)] font-black">{nextForCounter?.queue_number || "TBA"}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-white/60 uppercase tracking-wider">Waiting</span>
                    <span className="text-white font-black">{waitingForCounter}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-10">
          <div className="display-card p-5 flex items-center gap-5 border border-[var(--display-border)]">
            <div className="brand-display-accent w-14 h-14 rounded-2xl flex items-center justify-center border shadow-lg">
              <i className="fas fa-hourglass-half text-2xl" />
            </div>
            <div>
              <p className="text-[10px] text-white/60 uppercase font-black tracking-widest mb-1">Total Waiting</p>
              <h5 className="text-3xl font-black text-white leading-none">{waitingCount}</h5>
            </div>
          </div>

          <div className="display-card p-5 flex items-center gap-5 border border-[var(--display-border)]">
            <div className="brand-display-positive w-14 h-14 rounded-2xl flex items-center justify-center border shadow-lg">
              <i className="fas fa-stethoscope text-2xl" />
            </div>
            <div>
              <p className="text-[10px] text-white/60 uppercase font-black tracking-widest mb-1">Currently Serving</p>
              <h5 className="text-3xl font-black text-white leading-none">{allServing.length}</h5>
            </div>
          </div>
        </div>

        <div className="display-card p-6 border border-[var(--display-border)]">
          <div className="flex items-center gap-3 mb-6">
            <i className="fas fa-history text-white/30 text-xl" />
            <h3 className="text-sm font-black text-white uppercase tracking-[0.2em]">Recently Called</h3>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            {(display?.recent_called ?? []).length > 0 ? (
              display.recent_called.slice(0, 5).map((patient) => {
                const doctorName = resolveDoctorName(patient);
                const room = resolveRoom(doctorName);
                return (
                  <div key={`${patient.id}-${patient.called_at}`} className="bg-[var(--display-card-header)] rounded-xl p-4 border border-[var(--display-border)] hover:border-[var(--display-positive)] transition-all shadow-md">
                    <div className="text-xl font-black text-[var(--display-positive)] mb-1">{patient.queue_number}</div>
                    <div className="text-[9px] text-white/60 uppercase font-black mb-1 truncate">
                      {doctorName}{room ? ` · ${room}` : ""}
                    </div>
                    <div className="text-[9px] text-white/70 font-bold">
                      {patient.called_at ? new Date(patient.called_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "TBA"}
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="col-span-full py-8 text-center text-white/60 text-xs font-black uppercase tracking-[0.4em]">
                No recent activity
              </div>
            )}
          </div>
        </div>
      </main>

      <footer className="px-6 py-6 border-t border-[var(--display-border)] bg-[var(--display-card-header)] text-center">
        <p className="text-[10px] text-white/60 font-bold uppercase tracking-[0.2em] mb-2">
          © {new Date().getFullYear()} CHO CABADBARAN CITY Smart Queuing System. All rights reserved.
        </p>
        <p className="text-[9px] text-white/60 font-bold uppercase tracking-[0.4em]">
          Please listen for your name and queue number to be called.
        </p>
      </footer>
    </div>
  );
}
