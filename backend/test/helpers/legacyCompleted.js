// A cancellation is permanent (no Undo or Re-queue), so the only visit Undo and Re-queue still
// recover is a legacy "completed without a consultation start" visit. The current workflow cannot
// produce one (Complete needs a started consultation), so recovery tests create it here, the way an
// older record looks: status completed, completed_at set, consultation_started_at null, a new
// visit_state_revision, and no doctor counter still pointing at it. called_at and counter_id are
// kept as the original call left them.
const crypto = require("node:crypto");

async function makeLegacyCompleted(h, patientId, { reason } = {}) {
  const id = Number(patientId);
  const completedAt = new Date(h.clock?.now ?? Date.now()).toISOString();
  const apply = (row) => {
    row.status = "completed";
    row.completed_at = completedAt;
    row.consultation_started_at = null;
    if (reason !== undefined) row.reason = reason;
    row.visit_state_revision = crypto.randomUUID();
  };
  const stored = h.database?.patients?.find((row) => Number(row.id) === id);
  if (stored) {
    // Mock Supabase: the fake database holds the rows.
    apply(stored);
    for (const counter of h.database.counters) if (Number(counter.current_patient_id) === id) counter.current_patient_id = null;
  } else {
    // Development memory: getPatientById and setCounterOnline return the live in-memory rows.
    const live = await h.service.getPatientById(id);
    if (!live) throw new Error(`No visit ${id} to complete`);
    apply(live);
    for (const counter of (await h.service.getQueueOverview()).counters) {
      if (Number(counter.current_patient_id) !== id) continue;
      const row = await h.service.setCounterOnline(counter.id_num, counter.is_online !== false);
      if (row) row.current_patient_id = null;
    }
  }
  h.settings?.clearAwaitingAccept?.(id);
  return JSON.parse(JSON.stringify(await h.service.getPatientById(id)));
}

// The same legacy state in a real PostgreSQL / PGlite database (`db.query`). The installed Phase 2.1
// trigger rotates visit_state_revision on the UPDATE; the counter is released first.
async function makeLegacyCompletedPostgres(db, patientId, { reason } = {}) {
  const id = Number(patientId);
  await db.query("UPDATE public.counters SET current_patient_id = NULL WHERE current_patient_id = $1", [id]);
  const { rows } = await db.query(`UPDATE public.patients
    SET status = 'completed', completed_at = clock_timestamp(), consultation_started_at = NULL, reason = COALESCE($2, reason)
    WHERE id = $1 RETURNING *`, [id, reason ?? null]);
  if (rows.length !== 1) throw new Error(`No visit ${id} to complete`);
  return rows[0];
}

module.exports = { makeLegacyCompleted, makeLegacyCompletedPostgres };
