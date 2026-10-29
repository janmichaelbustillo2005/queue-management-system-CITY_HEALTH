const express = require('express');
const supabase = require('../lib/supabase');
const env = require('../config/env');
const { authenticateToken, authorizeRole } = require('../middleware/auth');
const router = express.Router();
router.use(authenticateToken, authorizeRole(['superadmin']));

const FILTER_KEYS = ['search', 'status', 'service', 'doctor', 'date', 'role', 'presence', 'account', 'visit', 'position'];
// Same values get_central_records accepts (backend/scripts/20261023-phase-b2-records.sql).
// 'no-show' is valid even before the enum migration; it then matches nothing.
const ALLOWED_VALUES = {
  status: ['waiting', 'serving', 'completed', 'cancelled', 'no-show'],
  role: ['admin', 'superadmin'],
  position: ['Super Admin', 'Doctor', 'Frontdesk'],
  presence: ['online', 'offline']
};
// The function raises 22023 for any invalid request (e.g. an unknown doctor); 22007/22008
// are PostgreSQL's own date errors.
const INVALID_REQUEST = new Set(['22023', '22007', '22008']);
// The Records SQL is not installed, or was written for another schema (original Phase B).
const NOT_INSTALLED = new Set(['PGRST202', 'PGRST205', '42883', '42P01', '42703']);

function isCalendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 1000 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// Server-side log line: route, category and an error code only. Database messages can echo
// filter values, so they are never logged or sent to the browser.
function logFailure(level, category, code) {
  const safeCode = /^(?:[0-9A-Z]{5}|PGRST\d{3}|transport|invalid-result)$/.test(String(code)) ? code : 'unknown';
  console[level](`[records] GET /api/records/${category} failed: ${safeCode}`);
}

router.get('/:category', async (req, res) => {
  const { category } = req.params;
  if (!['patients', 'staff', 'accounts', 'activity'].includes(category)) return res.status(404).json({ message: 'Unknown records category' });
  const page = Number(req.query.page || 1), limit = Number(req.query.limit || 20);
  if (!Number.isInteger(page) || page < 1 || page > 100000 || !Number.isInteger(limit) || limit < 1 || limit > 100) return res.status(400).json({ message: 'Invalid pagination' });
  const filters = {};
  for (const key of FILTER_KEYS) {
    const value = req.query[key] || '';
    if (typeof value !== 'string' || value.length > 100) return res.status(400).json({ message: 'Invalid filter' });
    filters[key] = value.trim();
  }
  if (filters.date && !isCalendarDate(filters.date)) return res.status(400).json({ message: 'Invalid date' });
  for (const [key, allowed] of Object.entries(ALLOWED_VALUES)) {
    if (filters[key] && !allowed.includes(filters[key])) return res.status(400).json({ message: 'Invalid filter' });
  }
  if (filters.visit && !/^\d{1,18}$/.test(filters.visit)) return res.status(400).json({ message: 'Invalid filter' });
  let result;
  try {
    result = await supabase.rpc('get_central_records', { p_category: category, p_filters: filters, p_page: page, p_limit: limit });
  } catch (_error) {
    logFailure('error', category, 'transport');
    return res.status(503).json({ message: 'Records storage unavailable. Please retry.' });
  }
  const { data, error } = result || {};
  if (error) {
    if (INVALID_REQUEST.has(error.code)) {
      logFailure('warn', category, error.code);
      return res.status(400).json({ message: 'Invalid records filter' });
    }
    logFailure('error', category, error.code);
    return res.status(503).json({ message: NOT_INSTALLED.has(error.code)
      ? 'Records storage unavailable. The Records database function is missing or incompatible; install Phase B.2.'
      : 'Records storage unavailable. Please retry.' });
  }
  if (!data || !Array.isArray(data.rows) || !Number.isSafeInteger(data.total)) {
    logFailure('error', category, 'invalid-result');
    return res.status(503).json({ message: 'Records storage unavailable. The Records database returned an unexpected result.' });
  }
  // D1 shared dispatch: a visit that was never called has no treating doctor. Phase B.2 still
  // labels it with its former service doctor ('service'); report it as unassigned instead.
  // (A doctor filter in get_central_records still matches those visits; see the D1 report.)
  if (category === 'patients' && env.doctorDispatchMode === 'shared') {
    data.rows = data.rows.map((row) => row?.doctor_source === 'service' ? { ...row, doctor: null, doctor_source: 'unassigned' } : row);
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.json(data);
});
module.exports = router;
