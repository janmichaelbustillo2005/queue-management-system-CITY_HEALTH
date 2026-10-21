const express = require('express');
const supabase = require('../lib/supabase');
const { authenticateToken, authorizeRole } = require('../middleware/auth');
const router = express.Router();
router.use(authenticateToken, authorizeRole(['superadmin']));
router.get('/:category', async (req, res) => {
  const { category } = req.params;
  if (!['patients', 'staff', 'accounts', 'activity'].includes(category)) return res.status(404).json({ message: 'Unknown records category' });
  const page = Number(req.query.page || 1), limit = Number(req.query.limit || 20);
  if (!Number.isInteger(page) || page < 1 || page > 100000 || !Number.isInteger(limit) || limit < 1 || limit > 100) return res.status(400).json({ message: 'Invalid pagination' });
  const filters = {};
  for (const key of ['search', 'status', 'service', 'doctor', 'date', 'role', 'presence', 'account', 'visit', 'position']) {
    const value = req.query[key] || '';
    if (typeof value !== 'string' || value.length > 100) return res.status(400).json({ message: 'Invalid filter' });
    filters[key] = value.trim();
  }
  if (filters.date && (!/^\d{4}-\d{2}-\d{2}$/.test(filters.date) || !Number.isFinite(Date.parse(filters.date)))) return res.status(400).json({ message: 'Invalid date' });
  try {
    const { data, error } = await supabase.rpc('get_central_records', { p_category: category, p_filters: filters, p_page: page, p_limit: limit });
    if (error) throw error;
    res.setHeader('Cache-Control', 'no-store');
    return res.json(data);
  } catch (_error) {
    return res.status(503).json({ message: 'Records storage unavailable. Verify the Phase B migration is installed.' });
  }
});
module.exports = router;

