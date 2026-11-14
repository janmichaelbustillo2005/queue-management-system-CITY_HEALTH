import { useEffect, useRef, useState } from "react";
import { request } from "../lib/api";
import {
  CABADBARAN_BARANGAYS, RESIDENCY_CITY, RESIDENCY_PROVINCE, RESIDENCY_STREET_MAX,
  formatResidency, parseResidency, residencyDetailProblem, suggestResidencies
} from "../lib/residency";

// RES1/RES2: the one Residency control. Typing searches two sources at once:
//   - Google Maps (through the backend, only when it has a key, and only for mapSearch callers),
//   - the 31 verified barangays of Cabadbaran City (always, offline).
// A map result is accepted only after the backend confirms it lies in Cabadbaran City; when Google
// gives no official barangay, the Front Desk chooses one. "Enter address manually" opens a compact
// barangay + Purok / Street / House No. form inside the same panel for addresses the map lacks.
//
// value: the bar's text, which is also what is saved.
// selection: { chosen, place } from the last onChange. chosen is true only for an address taken
//   from a suggestion or the manual form; typing makes it false. place is the backend's verified
//   map place ({ token, barangay, detail, placeId, formattedAddress }) or null.
// onChange(text, selection).
// ARIA combobox: arrow keys move through the suggestions, Enter chooses, Escape closes.

const PLACEHOLDER = "Search barangay, purok, street, or address in Cabadbaran City...";
const ADDRESS_SUFFIX = `${RESIDENCY_CITY}, ${RESIDENCY_PROVINCE}`;
const MAP_MIN_QUERY = 3;
const MAP_DEBOUNCE_MS = 350;
const MAP_UNAVAILABLE = "Map search is unavailable right now. Use the barangay list below, or enter the address manually.";
const clean = (text) => String(text ?? "").trim().replace(/\s+/g, " ");
const NOT_CHOSEN = { chosen: false, place: null };

// Google asks for a fresh token per search session (a v4 UUID is recommended, at most 36 characters).
function newSessionToken() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

// Whether the saved text is exactly what the verified map place gave: barangay and detail both from Google.
export function isMapVerified(text, selection) {
  const place = selection?.place;
  return Boolean(selection?.chosen && place?.barangay && clean(text) === formatResidency({ street: place.detail, barangay: place.barangay }));
}

function SearchIcon() {
  return (
    <svg className="residency-search-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.868-3.834zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z" />
    </svg>
  );
}

function BarangayOptionText({ item }) {
  const [start, end] = item.match || [0, 0];
  const name = item.barangay;
  return (
    <>
      <span className="residency-search-option-main">
        {item.street ? `${item.street}, ` : ""}Brgy. {name.slice(0, start)}
        {end > start ? <mark>{name.slice(start, end)}</mark> : null}
        {name.slice(end)}
      </span>
      <span className="residency-search-option-sub">{ADDRESS_SUFFIX}</span>
    </>
  );
}

function MapOptionText({ item }) {
  return (
    <>
      <span className="residency-search-option-main">{item.mainText}</span>
      {item.secondaryText ? <span className="residency-search-option-sub">{item.secondaryText}</span> : null}
    </>
  );
}

function BarangaySelect({ id, value, onChange, invalid, describedBy }) {
  return (
    <select id={id} className="residency-search-select" value={value} onChange={(event) => onChange(event.target.value)}
      aria-invalid={invalid ? "true" : undefined} aria-describedby={describedBy}>
      <option value="" disabled>-- Select Barangay --</option>
      {CABADBARAN_BARANGAYS.map((name) => <option key={name} value={name}>{name}</option>)}
    </select>
  );
}

export default function ResidencySearch({
  id, value, selection = null, onChange, error = "", disabled = false, readOnly = false, mapSearch = false,
  label = "Residency", labelClassName = "", notice = null
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [detailDraft, setDetailDraft] = useState("");
  const [focusTarget, setFocusTarget] = useState("");
  const [mapState, setMapState] = useState("idle"); // idle | loading | ready | error
  const [mapResults, setMapResults] = useState([]);
  const [mapMessage, setMapMessage] = useState("");
  const [resolving, setResolving] = useState(false);
  const [pending, setPending] = useState(null); // a verified map place still needing its barangay
  const [pickBarangay, setPickBarangay] = useState("");
  const [manual, setManual] = useState(null); // { barangay, detail, error } while the manual form is open
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const sessionRef = useRef(null);
  const mapOffRef = useRef(false);
  const searchVersionRef = useRef(0);

  const locked = disabled || readOnly;
  const text = String(value ?? "");
  const query = clean(text);
  const chosen = Boolean(selection?.chosen);
  const parsed = parseResidency(text);
  const showPanel = open && !locked;
  // A chosen barangay without a Purok / Street / House No. yet: the panel offers to add one.
  const detailMode = Boolean(chosen && parsed && !parsed.street);
  const searching = showPanel && !pending && !manual && !detailMode;
  const mapEnabled = mapSearch && !mapOffRef.current;
  const local = searching && !chosen ? suggestResidencies(text, { limit: query ? 8 : 31 }) : [];
  const mapShown = searching && !chosen && mapEnabled && query.length >= MAP_MIN_QUERY;
  const options = [
    ...(mapShown ? mapResults.map((item) => ({ kind: "map", key: `map-${item.placeId}`, item })) : []),
    ...local.map((item) => ({ kind: "barangay", key: `brgy-${item.barangay}`, item }))
  ];
  const listId = `${id}-listbox`;
  const optionId = (index) => `${id}-option-${index}`;
  const errorId = `${id}-error`;
  const statusId = `${id}-status`;
  const noticeId = `${id}-notice`;
  const detailId = `${id}-detail`;
  const draftProblem = detailMode && clean(detailDraft) ? residencyDetailProblem(detailDraft) : "";

  useEffect(() => {
    if (!focusTarget) return;
    setFocusTarget("");
    if (typeof document !== "undefined") document.getElementById(focusTarget)?.focus();
  }, [focusTarget]);

  useEffect(() => {
    if (locked) { setOpen(false); setActive(-1); setPending(null); setManual(null); }
  }, [locked]);

  useEffect(() => {
    if (active < 0 || typeof document === "undefined") return;
    document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  // Map search after a pause in typing (each request is billed). A slower earlier answer never
  // replaces a later one, and a failure leaves the barangay list and the form untouched.
  useEffect(() => {
    const version = ++searchVersionRef.current;
    if (!mapShown) {
      setMapState("idle");
      return undefined;
    }
    setMapResults([]); // results for an earlier text are never offered for this one
    setMapState("loading");
    const timer = setTimeout(async () => {
      sessionRef.current ||= newSessionToken();
      let data;
      try {
        data = await request(`/address-search?q=${encodeURIComponent(query)}&session=${encodeURIComponent(sessionRef.current)}`);
      } catch (searchError) {
        data = { error: searchError?.message };
      }
      if (version !== searchVersionRef.current) return;
      if (data?.available === false) {
        mapOffRef.current = true; // no key on the server: stop asking for the rest of this form
        setMapResults([]);
        setMapState("idle");
      } else if (data?.error || !Array.isArray(data?.suggestions)) {
        setMapResults([]);
        setMapMessage(MAP_UNAVAILABLE);
        setMapState("error");
      } else {
        setMapResults(data.suggestions);
        setMapState("ready");
      }
    }, MAP_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [mapShown, query]); // eslint-disable-line react-hooks/exhaustive-deps

  function close() {
    setOpen(false);
    setActive(-1);
    setPending(null);
    setManual(null);
  }

  // A complete address: close; a barangay without detail: offer the detail entry.
  function settle(label, place) {
    onChange(label, { chosen: true, place });
    setActive(-1);
    setPending(null);
    setManual(null);
    if (parseResidency(label)?.street) {
      setOpen(false);
    } else {
      setDetailDraft("");
      setOpen(true);
      setFocusTarget(detailId);
    }
  }

  async function chooseMap(item) {
    if (resolving) return;
    setResolving(true);
    setMapMessage("");
    sessionRef.current ||= newSessionToken();
    let data;
    try {
      data = await request(`/address-search/place?id=${encodeURIComponent(item.placeId)}&session=${encodeURIComponent(sessionRef.current)}`);
    } catch (placeError) {
      data = { error: placeError?.message };
    }
    sessionRef.current = null; // Place Details ends Google's search session
    setResolving(false);
    const place = data?.address;
    if (data?.error || !place?.token) {
      setMapMessage(data?.error || MAP_UNAVAILABLE);
      setMapState("error");
      return;
    }
    if (place.barangay) {
      settle(formatResidency({ street: place.detail, barangay: place.barangay }), place);
    } else {
      setPending(place);
      setPickBarangay("");
      setFocusTarget(`${id}-pick`);
    }
  }

  function choose(option) {
    if (option.kind === "map") chooseMap(option.item);
    else settle(option.item.label, null);
  }

  function usePickedBarangay() {
    if (!pending || !pickBarangay) return;
    settle(formatResidency({ street: pending.detail, barangay: pickBarangay }), pending);
  }

  function addDetail() {
    if (!parsed || draftProblem) return;
    if (clean(detailDraft)) onChange(formatResidency({ street: detailDraft, barangay: parsed.barangay }), { chosen: true, place: selection?.place || null });
    setDetailDraft("");
    inputRef.current?.focus();
    close();
  }

  // The manual form starts from what was typed: a barangay it names, and the rest as the detail.
  function openManual() {
    const guess = query ? suggestResidencies(text, { limit: 1 })[0] : null;
    const detail = guess ? guess.street : (residencyDetailProblem(query) ? "" : query);
    setManual({ barangay: guess?.barangay || "", detail, error: "" });
    setPending(null);
    setActive(-1);
    setOpen(true);
    setFocusTarget(`${id}-manual-barangay`);
  }

  function saveManual() {
    if (!manual) return;
    if (!manual.barangay) { setManual({ ...manual, error: "Choose the barangay." }); return; }
    const problem = residencyDetailProblem(manual.detail);
    if (problem) { setManual({ ...manual, error: problem }); return; }
    settle(formatResidency({ street: manual.detail, barangay: manual.barangay }), null);
  }

  function handleInput(event) {
    onChange(event.target.value, NOT_CHOSEN);
    setOpen(true);
    setActive(-1);
    setPending(null);
    setManual(null);
    setMapMessage("");
  }

  function handleKeyDown(event) {
    if (locked) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!showPanel) { setOpen(true); setActive(0); }
        else if (detailMode) setFocusTarget(detailId);
        else if (options.length) setActive((active + 1) % options.length);
        break;
      case "ArrowUp":
        if (!options.length) break;
        event.preventDefault();
        setActive(active <= 0 ? options.length - 1 : active - 1);
        break;
      case "Enter":
        // Enter chooses while the list is open; it submits the form only when the list is closed.
        if (!showPanel) break;
        if (options.length) { event.preventDefault(); choose(options[active >= 0 ? active : 0]); }
        else if (detailMode || pending || manual) { event.preventDefault(); }
        break;
      case "Escape":
        if (!showPanel) break;
        event.preventDefault();
        close();
        break;
      default:
    }
  }

  // Enter in a field of the panel's form confirms it; on a button, Enter keeps the button's own action.
  function handlePanelKeyDown(event, action) {
    if (event.key === "Enter" && ["INPUT", "SELECT"].includes(event.target?.tagName)) { event.preventDefault(); action(); }
    else if (event.key === "Escape") { event.preventDefault(); inputRef.current?.focus(); close(); }
  }

  function handleBlur(event) {
    if (!rootRef.current?.contains(event.relatedTarget)) close();
  }

  function clear() {
    onChange("", NOT_CHOSEN);
    setDetailDraft("");
    setActive(-1);
    setPending(null);
    setManual(null);
    setMapMessage("");
    setOpen(true);
    inputRef.current?.focus();
  }

  let status = "";
  if (readOnly) status = "Saved address.";
  else if (chosen && parsed) {
    status = isMapVerified(text, selection)
      ? "Selected from Google Maps. The map confirmed the barangay; the house itself is not checked."
      : selection?.place
        ? "Found on Google Maps; the barangay or details were entered by the Front Desk."
        : "Entered manually from the official barangay list. Not checked on a map.";
  } else if (!query) status = `Type the barangay, purok or street. ${ADDRESS_SUFFIX} is added automatically.`;
  const statusKind = readOnly ? "" : chosen && parsed ? (isMapVerified(text, selection) ? " is-map" : " is-manual") : "";
  const describedBy = [error ? errorId : status ? statusId : "", notice ? noticeId : ""].filter(Boolean).join(" ") || undefined;
  const groupStart = mapShown ? mapResults.length : 0;

  const optionNode = (option, index) => (
    <div
      key={option.key}
      id={optionId(index)}
      role="option"
      aria-selected={index === active ? "true" : "false"}
      className={`residency-search-option${index === active ? " is-active" : ""}${option.kind === "map" ? " is-map" : ""}`}
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={() => setActive(index)}
      onClick={() => choose(option)}
    >
      {option.kind === "map" ? <MapOptionText item={option.item} /> : <BarangayOptionText item={option.item} />}
    </div>
  );

  const manualButton = (
    <button type="button" className="residency-search-manual-open" onClick={openManual}>
      Can’t find it? Enter address manually
    </button>
  );

  let panel = null;
  if (showPanel) {
    if (pending) {
      panel = (
        <div className="residency-search-dialog" role="group" aria-labelledby={`${id}-pick-title`}>
          <p id={`${id}-pick-title`} className="residency-search-dialog-title">Google Maps found this place in Cabadbaran City but not its barangay</p>
          <p className="residency-search-dialog-note">{pending.formattedAddress || pending.detail}</p>
          <label htmlFor={`${id}-pick`}>Barangay</label>
          <div className="residency-search-dialog-row" onKeyDown={(event) => handlePanelKeyDown(event, usePickedBarangay)}>
            <BarangaySelect id={`${id}-pick`} value={pickBarangay} onChange={setPickBarangay} />
            <button type="button" className="residency-search-dialog-primary" onClick={usePickedBarangay} disabled={!pickBarangay}>Use address</button>
          </div>
          <button type="button" className="residency-search-dialog-link" onClick={() => setPending(null)}>Back to results</button>
        </div>
      );
    } else if (manual) {
      panel = (
        <div className="residency-search-dialog" role="group" aria-labelledby={`${id}-manual-title`} onKeyDown={(event) => handlePanelKeyDown(event, saveManual)}>
          <p id={`${id}-manual-title`} className="residency-search-dialog-title">Enter address manually</p>
          <p className="residency-search-dialog-note">For addresses the map does not have. {ADDRESS_SUFFIX}, Philippines is added automatically; the address is saved as manually entered.</p>
          <label htmlFor={`${id}-manual-barangay`}>Barangay <span className="residency-search-required" aria-hidden="true">*</span></label>
          <BarangaySelect id={`${id}-manual-barangay`} value={manual.barangay} onChange={(barangay) => setManual({ ...manual, barangay, error: "" })}
            invalid={manual.error && !manual.barangay} describedBy={manual.error ? `${id}-manual-error` : undefined} />
          <label htmlFor={`${id}-manual-detail`}>Purok / Street / House No. <span className="residency-search-optional">(optional)</span></label>
          <input id={`${id}-manual-detail`} type="text" className="residency-search-detail-input" placeholder="e.g. Purok 3, Rizal St., House 12"
            value={manual.detail} maxLength={RESIDENCY_STREET_MAX} autoComplete="off"
            onChange={(event) => setManual({ ...manual, detail: event.target.value, error: "" })}
            aria-describedby={manual.error ? `${id}-manual-error` : undefined} />
          {manual.error ? <p id={`${id}-manual-error`} className="residency-search-error" role="alert">{manual.error}</p> : null}
          <div className="residency-search-dialog-actions">
            <button type="button" className="residency-search-dialog-link" onClick={() => { setManual(null); setFocusTarget(id); }}>Cancel</button>
            <button type="button" className="residency-search-dialog-primary" onClick={saveManual}>Use this address</button>
          </div>
        </div>
      );
    } else if (detailMode) {
      panel = (
        <div className="residency-search-detail">
          <p className="residency-search-detail-title">Brgy. {parsed.barangay} selected</p>
          <label htmlFor={detailId}>Purok / Street / House No. <span className="residency-search-optional">(optional)</span></label>
          <div className="residency-search-detail-row">
            <input
              id={detailId}
              type="text"
              className="residency-search-detail-input"
              placeholder="e.g. Purok 3, Rizal St."
              value={detailDraft}
              maxLength={RESIDENCY_STREET_MAX}
              onChange={(event) => setDetailDraft(event.target.value)}
              onKeyDown={(event) => handlePanelKeyDown(event, addDetail)}
              aria-invalid={draftProblem ? "true" : undefined}
              aria-describedby={draftProblem ? `${detailId}-error` : `${detailId}-note`}
              autoComplete="off"
            />
            <button type="button" className="residency-search-detail-add" onClick={addDetail} disabled={!clean(detailDraft) || Boolean(draftProblem)}>
              Add
            </button>
          </div>
          {draftProblem
            ? <p id={`${detailId}-error`} className="residency-search-error">{draftProblem}</p>
            : <p id={`${detailId}-note`} className="residency-search-detail-note">Press Enter to add it, or Esc to keep the barangay only.</p>}
        </div>
      );
    } else if (!chosen) {
      // (A chosen, complete address shows no panel: typing or clearing starts a new search.)
      const nothing = !options.length && !(mapShown && mapState === "loading") && !resolving;
      panel = (
        <>
          {options.length ? (
            <div id={listId} role="listbox" aria-label="Addresses in Cabadbaran City" className="residency-search-list">
              {mapShown && mapResults.length ? (
                <div role="group" aria-labelledby={`${id}-map-heading`}>
                  <p id={`${id}-map-heading`} className="residency-search-heading" role="presentation">Google Maps results</p>
                  {options.slice(0, groupStart).map((option, index) => optionNode(option, index))}
                </div>
              ) : null}
              {local.length ? (
                <div role="group" aria-labelledby={`${id}-brgy-heading`}>
                  <p id={`${id}-brgy-heading`} className="residency-search-heading" role="presentation">
                    {query ? "Verified barangays of Cabadbaran City" : "Barangays of Cabadbaran City"}
                  </p>
                  {options.slice(groupStart).map((option, index) => optionNode(option, groupStart + index))}
                </div>
              ) : null}
            </div>
          ) : null}
          {mapShown && mapState === "loading" ? <p className="residency-search-status is-loading" role="status">Searching Google Maps…</p> : null}
          {resolving ? <p className="residency-search-status is-loading" role="status">Checking the selected place…</p> : null}
          {mapMessage ? <p className="residency-search-status is-warning" role="status">{mapMessage}</p> : null}
          {nothing ? (
            <p className="residency-search-status" role="status">
              No address in Cabadbaran City matches “{query}”. Include the barangay, for example “Purok 3, Calibunan”, or enter it manually.
            </p>
          ) : null}
          <div className="residency-search-footer">
            {manualButton}
            {mapShown && mapResults.length ? <span className="residency-search-attribution">Map results by Google</span> : null}
          </div>
        </>
      );
    }
  }

  return (
    <div className="residency-search" ref={rootRef} onBlur={handleBlur}>
      <label htmlFor={id} className={labelClassName}>
        {label} <span className="residency-search-required" aria-hidden="true">*</span>
      </label>
      <div className="residency-search-field">
        <div className={`residency-search-bar${error ? " is-invalid" : ""}${locked ? " is-locked" : ""}`}>
          <SearchIcon />
          <input
            id={id}
            ref={inputRef}
            type="text"
            className="residency-search-input"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={showPanel && options.length > 0 ? "true" : "false"}
            aria-controls={listId}
            aria-activedescendant={showPanel && active >= 0 && active < options.length ? optionId(active) : undefined}
            aria-required="true"
            aria-invalid={error ? "true" : undefined}
            aria-describedby={describedBy}
            aria-busy={resolving || (mapShown && mapState === "loading") ? "true" : undefined}
            placeholder={PLACEHOLDER}
            value={text}
            onChange={handleInput}
            onClick={() => { if (!locked) setOpen(true); }}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            readOnly={readOnly}
            autoComplete="off"
            spellCheck={false}
          />
          {text && !locked ? (
            <button type="button" className="residency-search-clear" aria-label="Clear residency" onClick={clear}>
              <span aria-hidden="true">×</span>
            </button>
          ) : null}
        </div>
        {panel ? <div className="residency-search-panel">{panel}</div> : null}
      </div>

      {error
        ? <p id={errorId} className="residency-search-error" role="alert">{error}</p>
        : status ? <p id={statusId} className={`residency-search-hint${statusKind}`}>{status}</p> : null}
      {notice ? <div id={noticeId}>{notice}</div> : null}
    </div>
  );
}
