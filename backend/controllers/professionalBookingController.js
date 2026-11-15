const Booking = require('../models/Booking');
const { formatBookingDetail, formatAssignee } = require('./bookingController');
const { notifyBookingStatus } = require('../services/notifications');
const {
  PROFESSIONAL_ALLOWED_TRANSITIONS,
  ACTIVE_STATUSES,
  PAST_STATUSES,
  todayDateString,
} = require('../utils/bookingStatus');
const {
  pushStatusHistory,
  pushTrackingPoint,
  actorFromProfessional,
} = require('../utils/bookingHistory');

function isAssignee(booking, professionalId) {
  const id = String(professionalId);
  return (booking.assignees || []).some((a) => String(a._id || a) === id);
}

function assigneeFilter(professionalId) {
  return { assignees: professionalId };
}

function formatCustomer(user) {
  if (!user || typeof user !== 'object') {
    return { id: user || null, name: null, phone: null };
  }
  return {
    id: user._id || user.id || null,
    name: user.fullName || user.name || null,
    phone: user.phone || null,
    email: user.email || null,
  };
}

function formatListCard(booking) {
  const customer = formatCustomer(booking.user);
  return {
    id: booking._id,
    reference: booking.reference,
    status: booking.status,
    categorySlug: booking.categorySlug,
    category: booking.category
      ? { id: booking.category._id, name: booking.category.name, slug: booking.category.slug }
      : { slug: booking.categorySlug },
    schedule: booking.schedule,
    address: {
      label: booking.address?.label || null,
      line: booking.address?.line || null,
      area: booking.address?.area || null,
      city: booking.address?.city || null,
      lat: booking.address?.lat ?? null,
      lng: booking.address?.lng ?? null,
    },
    customer: {
      name: customer.name,
      phone: customer.phone,
    },
    packageName: booking.packageSnapshot?.name || null,
    pricing: booking.pricing
      ? {
          total: booking.pricing.total,
          currency: booking.pricing.currency || 'PKR',
        }
      : null,
    tracking: booking.tracking || null,
    createdAt: booking.createdAt,
    updatedAt: booking.updatedAt,
  };
}

function formatProfessionalDetail(booking) {
  const detail = formatBookingDetail(booking);
  const customer = formatCustomer(booking.user);
  const assignees = (booking.assignees || []).map(formatAssignee).filter(Boolean);

  return {
    ...detail,
    customer: {
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
    },
    address: {
      label: booking.address?.label || null,
      line: booking.address?.line || null,
      area: booking.address?.area || null,
      city: booking.address?.city || null,
      lat: booking.address?.lat ?? null,
      lng: booking.address?.lng ?? null,
    },
    packageSnapshot: booking.packageSnapshot,
    addOns: booking.addOns || [],
    propertyConfig: booking.propertyConfig,
    schedule: booking.schedule,
    status: booking.status,
    pricing: booking.pricing,
    paymentStatus: booking.paymentStatus,
    assignees,
    tracking: booking.tracking || {},
    completion: booking.completion || {},
    allocation: booking.allocation || {},
  };
}

async function loadAssignedBooking(req, res) {
  const booking = await Booking.findById(req.params.id)
    .populate('user', 'fullName phone email')
    .populate('category', 'name slug')
    .populate('assignees');

  if (!booking) {
    res.status(404).json({ message: 'Booking not found' });
    return null;
  }

  if (!isAssignee(booking, req.professional._id)) {
    res.status(403).json({ message: 'Not assigned to this booking' });
    return null;
  }

  return booking;
}

function scopeFilter(scope, today) {
  switch (scope) {
    case 'today':
      return {
        'schedule.date': today,
        status: { $nin: PAST_STATUSES },
      };
    case 'upcoming':
      return {
        'schedule.date': { $gt: today },
        status: { $nin: PAST_STATUSES },
      };
    case 'past':
      return {
        $or: [
          { status: { $in: PAST_STATUSES } },
          { 'schedule.date': { $lt: today }, status: { $nin: PAST_STATUSES } },
        ],
      };
    case 'active':
      // Includes confirmed (assigned / awaiting pro start) — mirrors ACTIVE_STATUSES
      return { status: { $in: ACTIVE_STATUSES } };
    default:
      return null;
  }
}

const getDashboard = async (req, res) => {
  try {
    const professionalId = req.professional._id;
    const today = todayDateString();
    const base = assigneeFilter(professionalId);

    const [
      assignedTotal,
      todayCount,
      upcomingCount,
      activeCount,
      completedCount,
      todayJobs,
      upcomingJobs,
    ] = await Promise.all([
      Booking.countDocuments(base),
      Booking.countDocuments({
        ...base,
        'schedule.date': today,
        status: { $nin: PAST_STATUSES },
      }),
      Booking.countDocuments({
        ...base,
        'schedule.date': { $gt: today },
        status: { $nin: PAST_STATUSES },
      }),
      Booking.countDocuments({
        ...base,
        status: { $in: ACTIVE_STATUSES },
      }),
      Booking.countDocuments({ ...base, status: 'completed' }),
      Booking.find({
        ...base,
        'schedule.date': today,
        status: { $nin: PAST_STATUSES },
      })
        .sort({ 'schedule.startTime': 1, createdAt: 1 })
        .limit(20)
        .populate('user', 'fullName phone')
        .populate('category', 'name slug'),
      Booking.find({
        ...base,
        'schedule.date': { $gt: today },
        status: { $nin: PAST_STATUSES },
      })
        .sort({ 'schedule.date': 1, 'schedule.startTime': 1 })
        .limit(20)
        .populate('user', 'fullName phone')
        .populate('category', 'name slug'),
    ]);

    res.status(200).json({
      stats: {
        assignedTotal,
        today: todayCount,
        upcoming: upcomingCount,
        active: activeCount,
        completed: completedCount,
      },
      todayJobs: todayJobs.map(formatListCard),
      upcomingJobs: upcomingJobs.map(formatListCard),
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to load dashboard', error: error.message });
  }
};

const listBookings = async (req, res) => {
  try {
    const scope = String(req.query.scope || 'active').toLowerCase();
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const today = todayDateString();

    const scoped = scopeFilter(scope, today);
    if (!scoped) {
      return res.status(400).json({
        message: 'Invalid scope. Use today, upcoming, past, or active',
      });
    }

    const filter = { ...assigneeFilter(req.professional._id), ...scoped };

    const sort =
      scope === 'past'
        ? { 'schedule.date': -1, updatedAt: -1 }
        : scope === 'upcoming' || scope === 'today'
          ? { 'schedule.date': 1, 'schedule.startTime': 1 }
          : { updatedAt: -1 };

    const [total, bookings] = await Promise.all([
      Booking.countDocuments(filter),
      Booking.find(filter)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('user', 'fullName phone')
        .populate('category', 'name slug'),
    ]);

    res.status(200).json({
      scope,
      bookings: bookings.map(formatListCard),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to list bookings', error: error.message });
  }
};

const getBooking = async (req, res) => {
  try {
    const booking = await loadAssignedBooking(req, res);
    if (!booking) return;

    res.status(200).json({ booking: formatProfessionalDetail(booking) });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch booking', error: error.message });
  }
};

const updateLocation = async (req, res) => {
  try {
    const booking = await loadAssignedBooking(req, res);
    if (!booking) return;

    const { lat, lng, minutesAway, distanceKm } = req.body;
    if (lat === undefined || lng === undefined) {
      return res.status(400).json({ message: 'lat and lng are required' });
    }
    const latN = Number(lat);
    const lngN = Number(lng);
    if (Number.isNaN(latN) || Number.isNaN(lngN)) {
      return res.status(400).json({ message: 'lat and lng must be numbers' });
    }

    const proActor = actorFromProfessional(req.professional);
    pushTrackingPoint(booking, {
      lat: latN,
      lng: lngN,
      minutesAway,
      distanceKm,
      ...proActor,
    });

    // Mirror admin tracking: first location ping advances assigning/confirmed → en_route
    const previousStatus = booking.status;
    let statusChanged = false;
    if (['confirmed', 'assigning'].includes(booking.status)) {
      booking.status = 'en_route';
      statusChanged = true;
      pushStatusHistory(booking, {
        fromStatus: previousStatus,
        toStatus: 'en_route',
        ...proActor,
        note: 'Location update',
      });
    }

    await booking.save();
    await booking.populate('assignees');
    await booking.populate('category', 'name slug');
    await booking.populate('user', 'fullName phone email');

    if (statusChanged) {
      notifyBookingStatus(booking, previousStatus).catch((err) =>
        console.error('[notifications] pro tracking status notify failed:', err.message)
      );
    }

    res.status(200).json({
      message: 'Location updated',
      booking: formatProfessionalDetail(booking),
      statusChanged,
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to update location', error: error.message });
  }
};

const updateStatus = async (req, res) => {
  try {
    const { status, highlights, notes } = req.body;
    if (!status) {
      return res.status(400).json({ message: 'status is required' });
    }

    const booking = await loadAssignedBooking(req, res);
    if (!booking) return;

    const allowed = PROFESSIONAL_ALLOWED_TRANSITIONS[booking.status] || [];
    if (!allowed.includes(status)) {
      return res.status(400).json({
        message: `Cannot move from ${booking.status} to ${status}`,
        allowed,
      });
    }

    const previousStatus = booking.status;
    booking.status = status;

    if (status === 'completed') {
      booking.completion = booking.completion || {};
      booking.completion.completedAt = new Date();
      if (Array.isArray(highlights)) booking.completion.highlights = highlights;
      if (notes !== undefined) booking.completion.notes = notes;
    }

    pushStatusHistory(booking, {
      fromStatus: previousStatus,
      toStatus: status,
      ...actorFromProfessional(req.professional),
      note: notes || '',
    });

    await booking.save();
    const { bumpJobsCompletedForBooking } = require('../utils/professionalJobs');
    await bumpJobsCompletedForBooking(booking, previousStatus);
    await booking.populate('assignees');
    await booking.populate('category', 'name slug');
    await booking.populate('user', 'fullName phone email');

    notifyBookingStatus(booking, previousStatus).catch((err) =>
      console.error('[notifications] pro status notify failed:', err.message)
    );

    res.status(200).json({
      message: 'Status updated',
      booking: formatProfessionalDetail(booking),
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to update status', error: error.message });
  }
};

module.exports = {
  getDashboard,
  listBookings,
  getBooking,
  updateLocation,
  updateStatus,
};
