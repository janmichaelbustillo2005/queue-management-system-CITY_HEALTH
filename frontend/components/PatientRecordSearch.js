import { useEffect, useRef, useState } from "react";
import { request } from "../lib/api";

const MIN_SEARCH_LENGTH = 2;
const SEARCH_DELAY_MS = 300;

// "1990-04-12" -> "Apr 12, 1990". Birthdates are calendar dates, so UTC avoids a day shift.
export function formatRecordBirthdate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return "Not recorded";
  return new Date(`${value}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC"
  });
}

// Front Desk search of permanent patient records. Results carry only what tells similar
// names apart (Patient ID, birthdate, sex); Select hands the row to the page, which reads
// the full record from the server. Searching never creates or changes a record.
export default function PatientRecordSearch({ onSelect, disabled = false, selectedId = null }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [searchedTerm, setSearchedTerm] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requestRef = useRef(0);

  async function runSearch(text) {
    const term = String(text || "").trim();
    const version = ++requestRef.current;
    if (term.length < MIN_SEARCH_LENGTH) {
      setResults(null);
      setError("");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    let data;
    try {
      data = await request(`/patient-records?search=${encodeURIComponent(term)}`);
    } catch (err) {
      data = { error: err.message || "Patient search failed. Please retry." };
    }
    // A slower earlier search never replaces the results of a later one.
    if (version !== requestRef.current) return;
    setLoading(false);
    if (data?.error) {
      setResults(null);
      setError(data.error);
      return;
    }
    setResults(Array.isArray(data?.patients) ? data.patients : []);
    setTruncated(Boolean(data?.truncated));
    setSearchedTerm(term);
  }

  useEffect(() => {
    const timer = setTimeout(() => runSearch(query), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
    // runSearch reads only its argument and refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  return (
    <section className="patient-record-search brand-bg-subtle p-3 p-md-4 rounded-3 border brand-border mb-3" aria-labelledby="patient-record-search-label">
      <form role="search" onSubmit={(event) => { event.preventDefault(); runSearch(query); }}>
        <label id="patient-record-search-label" htmlFor="patient-record-search" className="frontdesk-section-title">
          <i className="bi bi-person-check-fill" aria-hidden="true" /> Search Existing Patient
        </label>
        <div className="input-group input-group-sm">
          <span className="input-group-text brand-border bg-white"><i className="bi bi-search" aria-hidden="true" /></span>
          <input
            id="patient-record-search"
            type="search"
            className="brand-input form-control"
            placeholder="Search patient by name..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            maxLength={100}
            autoComplete="off"
            disabled={disabled}
          />
          <button type="submit" className="btn btn-outline-secondary" disabled={disabled || loading}>Search</button>
        </div>
      </form>

      <div className="patient-record-results" aria-live="polite">
        {loading ? <p className="patient-record-status">Searching patient records…</p> : null}
        {!loading && error ? <p role="alert" className="patient-record-error">{error}</p> : null}
        {!loading && !error && results && results.length === 0 ? (
          <p className="patient-record-status">No registered patient matches “{searchedTerm}”. Check the spelling, or register a new patient using the form below.</p>
        ) : null}
        {!loading && !error && results && results.length > 0 ? (
          <>
            <h3 className="patient-record-results-title">Search Results</h3>
            <div className="table-responsive">
              <table className="table table-sm align-middle mb-0 patient-record-table">
                <thead>
                  <tr>
                    <th scope="col">Patient Name</th>
                    <th scope="col">Patient ID</th>
                    <th scope="col">Birthdate</th>
                    <th scope="col">Sex</th>
                    <th scope="col">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((row) => (
                    <tr key={row.id} className={String(row.id) === String(selectedId) ? "is-selected" : undefined}>
                      <td>{row.full_name}</td>
                      <td className="patient-record-code">{row.patient_code}</td>
                      <td>{formatRecordBirthdate(row.birthdate)}</td>
                      <td>{row.sex || "Not recorded"}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-sm btn-csu-primary"
                          onClick={() => onSelect(row)}
                          disabled={disabled}
                          aria-label={`Select ${row.full_name}, ${row.patient_code}`}
                        >
                          {String(row.id) === String(selectedId) ? "Selected" : "Select"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {truncated ? <p className="patient-record-status">Showing the first {results.length} matches. Type more of the name to narrow the list.</p> : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
