/**
 * Shared booking status transitions for admin + professional portals.
 * Professionals use PROFESSIONAL_ALLOWED_TRANSITIONS (safe subset without
 * admin-only moves like confirmed→assigning, and without cancel).
 */
const ALLOWED_TRANSITIONS = {
  confirmed: ['assigning', 'cancelled'],
  assigning: ['en_route', 'cancelled'],
  en_route: ['in_progress', 'cancelled'],
  in_progress: ['completed'],
  completed: [],
  cancelled: [],
};

/** Assignee lifecycle: assigning/confirmed → en_route → in_progress → completed */
const PROFESSIONAL_ALLOWED_TRANSITIONS = {
  confirmed: ['en_route'],
  assigning: ['en_route'],
  en_route: ['in_progress'],
  in_progress: ['completed'],
  completed: [],
  cancelled: [],
};

const ACTIVE_STATUSES = ['confirmed', 'assigning', 'en_route', 'in_progress'];
const PAST_STATUSES = ['completed', 'cancelled'];

function todayDateString(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

module.exports = {
  ALLOWED_TRANSITIONS,
  PROFESSIONAL_ALLOWED_TRANSITIONS,
  ACTIVE_STATUSES,
  PAST_STATUSES,
  todayDateString,
};
