'use strict';
/**
 * How much of GitHub's free allowance this machine has left.
 *
 * The honest part first, because the alternative is a number that looks
 * authoritative and is not: **GitHub does not expose remaining Codespaces
 * hours to the machine** (there is no local file, no environment variable and
 * no unauthenticated API for it), so this cannot be a reading — it is a meter.
 *
 * What it measures, and therefore what it can be trusted for:
 *
 *   compute  time this process was running × the number of cores it has.
 *            GitHub bills a Codespace per core-hour, so a 2-core machine that
 *            runs for an hour is 2 core-hours. Time while this app was not
 *            running is *not* counted, which makes the figure a floor, never
 *            an overstatement.
 *   storage  the size of `data/` sampled once a minute, integrated over time
 *            and divided by the hours in the month — GitHub bills storage in
 *            GB-months, which is an average, not a peak.
 *
 * The monthly free allowance is 120 core-hours and 15 GB-months on GitHub
 * Free, 180 on Pro. It is **monthly, in UTC, resetting on the 1st** — there is
 * no weekly cap, which is why there is no weekly meter here. The quota is a
 * setting, not a guess: a user who knows their plan can put the real number in.
 *
 * Everything is pure enough to test: `createMeter()` takes a clock and a
 * directory, so a month of usage can be simulated in milliseconds.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const GB = 1024 ** 3;
const HOUR = 3600 * 1000;

/* GitHub Free / Pro, from the Codespaces billing docs. */
const PLANS = {
  free: { label: 'GitHub Free', coreHours: 120, storageGb: 15 },
  pro: { label: 'GitHub Pro', coreHours: 180, storageGb: 20 },
  custom: { label: 'Set by hand', coreHours: 120, storageGb: 15 },
};

const DEFAULT_IDLE_MINUTES = 30;
const TICK_MS = 60 * 1000;
/* Keep a few months of history: enough to see a trend, not a database. */
const HISTORY_MONTHS = 6;

const round = (value, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;

/** `2026-11` — billing months are UTC, so the key is too. */
function monthKey(ms) {
  const date = new Date(ms);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The UTC month a timestamp falls in. */
function monthBounds(ms) {
  const date = new Date(ms);
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  return { start, end, hours: (end - start) / HOUR, days: (end - start) / (24 * HOUR) };
}

/**
 * GB-months consumed by holding `byteSeconds` of storage so far this month.
 *
 * GitHub's storage charge is an average over the month, not a peak: one GB held
 * for the whole month is 1 GB-month, and one GB held for half of it is 0.5. A
 * meter that reported the current size would overstate every job that is
 * deleted the same day, which is most of them.
 */
function gbMonths(byteSeconds, { hoursInMonth, hours } = {}) {
  const span = Number(hoursInMonth || hours) || 0;
  if (!byteSeconds || !span) return 0;
  return byteSeconds / 3600 / GB / span;
}

function freshState(now) {
  return {
    version: 1,
    settings: {
      plan: 'free',
      coreHours: PLANS.free.coreHours,
      storageGb: PLANS.free.storageGb,
      idleMinutes: DEFAULT_IDLE_MINUTES,
      /* Detected, but a 2-core machine is worth saying out loud: it doubles
         every hour it runs. */
      cores: Math.max(1, os.cpus().length),
    },
    month: monthKey(now),
    coreSeconds: 0,
    byteSeconds: 0,
    peakBytes: 0,
    bytesNow: 0,
    lastTickAt: null,
    lastActivityAt: null,
    sessionStartedAt: null,
    sessions: 0,
    history: {},
  };
}

/**
 * @param {{dataDir: string, now?: () => number, cores?: number, log?: Function}} options
 */
function createMeter({ dataDir, now = () => Date.now(), cores, log = () => {} } = {}) {
  const file = path.join(dataDir, 'usage.json');
  let state = freshState(now());
  if (cores) state.settings.cores = Math.max(1, Number(cores) || 1);
  let ready = false;
  let saveTimer = null;
  let lastSaved = 0;
  let saveChain = Promise.resolve();

  async function load() {
    const raw = await fsp.readFile(file, 'utf8').catch(() => null);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          state = {
            ...state,
            ...parsed,
            settings: { ...state.settings, ...(parsed.settings || {}) },
            history: { ...(parsed.history || {}) },
          };
        }
      } catch {
        /* A corrupt meter must not stop the app; it starts a fresh month. */
      }
    }
    rollMonth();
    /* A previous process's last tick says nothing about this one: the gap
       between them is time this app was not measuring. */
    state.lastTickAt = now();
    state.sessionStartedAt = now();
    state.sessions = (Number(state.sessions) || 0) + 1;
    state.bytesNow = Number(state.bytesNow) || 0;
    state.peakBytes = Number(state.peakBytes) || 0;
    lastActivityAt = now();
    ready = true;
    await save(true);
    return describe();
  }

  let lastActivityAt = now();

  function rollMonth() {
    const key = monthKey(now());
    if (state.month === key) return false;
    /* Keep the finished month so the panel can show a trend rather than
       forgetting everything on the 1st. */
    state.history[state.month] = {
      coreSeconds: Math.round(state.coreSeconds || 0),
      byteSeconds: Math.round(state.byteSeconds || 0),
      peakBytes: Math.round(state.peakBytes || 0),
    };
    const keys = Object.keys(state.history).sort();
    while (keys.length > HISTORY_MONTHS) delete state.history[keys.shift()];
    state.month = key;
    state.coreSeconds = 0;
    state.byteSeconds = 0;
    state.peakBytes = 0;
    return true;
  }

  /** Something happened: a job ran, a page was used. */
  function touch() {
    lastActivityAt = now();
    state.lastActivityAt = lastActivityAt;
  }

  /**
   * Credit the time since the previous tick to this month.
   * `bytes` is what `data/` weighs right now.
   */
  function tick(bytes = state.bytesNow) {
    if (!ready) return describe();
    const at = now();
    const size = Math.max(0, Number(bytes) || 0);
    /* A month boundary is not usage: the interval from the last tick of the old
       month belongs to the old month, which has already been closed. Crediting
       it here would put up to a tick of yesterday's time on a fresh allowance. */
    if (rollMonth()) {
      state.lastTickAt = at;
      state.bytesNow = size;
      save();
      return describe();
    }
    const previous = state.lastTickAt;
    if (previous && at > previous) {
      const delta = at - previous; // ms this process was alive
      state.coreSeconds += (delta / 1000) * (Number(state.settings.cores) || 1);
      state.byteSeconds += size * (delta / 1000);
    }
    state.lastTickAt = at;
    state.bytesNow = size;
    state.peakBytes = Math.max(Number(state.peakBytes) || 0, size);
    save();
    return describe();
  }

  function scheduleSave(delay = 2000) {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      save();
    }, delay);
    if (saveTimer.unref) saveTimer.unref();
  }

  async function save(force = false) {
    if (!ready && !force) return;
    /* Ticks are a minute apart; writing every one of them is pointless on a
       disk that a video is already filling. */
    if (!force && now() - lastSaved < 15000) {
      scheduleSave(15000 - (now() - lastSaved));
      return;
    }
    lastSaved = now();
    const snapshot = JSON.stringify(state);
    /* One writer at a time: two overlapping saves share one temp file, and the
       loser's rename finds it already gone. */
    saveChain = saveChain.then(async () => {
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(tmp, snapshot);
        await fsp.rename(tmp, file);
      } catch (err) {
        log(`[usage] could not save the meter: ${err.message}`);
      }
    });
    await saveChain;
  }

  async function setSettings(patch = {}) {
    const settings = state.settings;
    if (patch.plan && PLANS[patch.plan]) {
      settings.plan = patch.plan;
      /* Picking a plan sets the quotas that belong to it; a custom quota below
         still wins, because it is what the user asked for. */
      if (patch.plan !== 'custom') {
        settings.coreHours = PLANS[patch.plan].coreHours;
        settings.storageGb = PLANS[patch.plan].storageGb;
      }
    }
    for (const [key, min, max] of [
      ['coreHours', 1, 10000],
      ['storageGb', 1, 10000],
      ['idleMinutes', 1, 1440],
      ['cores', 1, 128],
    ]) {
      const value = Number(patch[key]);
      if (Number.isFinite(value) && value >= min && value <= max) settings[key] = Math.round(value * 100) / 100;
    }
    if (patch.plan === 'custom') settings.plan = 'custom';
    /* A quota that does not match a stock plan is custom, whatever was sent. */
    const stock = PLANS[settings.plan];
    if (stock && settings.plan !== 'custom' && (Number(settings.coreHours) !== stock.coreHours || Number(settings.storageGb) !== stock.storageGb)) {
      settings.plan = 'custom';
    }
    /* Awaited: the answer to "quota saved" must survive the machine stopping
       a millisecond later, which is exactly when people change this. */
    await save(true);
    return settings;
  }

  function describe() {
    const at = now();
    /* Reading the panel at 00:01 on the 1st should not show last month's
       numbers under this month's name. */
    rollMonth();
    const bounds = monthBounds(at);
    const hoursElapsed = Math.max(0, (at - bounds.start) / HOUR);
    const coreSeconds = Number(state.coreSeconds) || 0;
    const byteSeconds = Number(state.byteSeconds) || 0;
    const settings = state.settings;
    const coreHours = coreSeconds / 3600;
    const quota = Number(settings.coreHours) || PLANS.free.coreHours;
    const coresNow = Math.max(1, Number(settings.cores) || 1);

    const storedGbMonths = gbMonths(byteSeconds, bounds);
    const projectedGbMonths = hoursElapsed > 0 ? storedGbMonths * (bounds.hours / hoursElapsed) : 0;
    const projectedCoreHours = hoursElapsed > 0 ? (coreHours / hoursElapsed) * bounds.hours : 0;

    const sessionStart = Number(state.sessionStartedAt) || at;
    const idleMinutes = Number(settings.idleMinutes) || DEFAULT_IDLE_MINUTES;
    const lastActivity = Number(lastActivityAt) || sessionStart;
    const idleLeft = Math.max(0, Math.round((lastActivity + idleMinutes * 60000 - at) / 1000));

    return {
      /* What this is, in the words it deserves. */
      meter: {
        source: 'local',
        file: 'data/usage.json',
        countsOnlyWhileRunning: true,
        note:
          'Measured by this app while it is running: time × cores, and the size of data/ sampled every minute. ' +
          'GitHub does not publish remaining Codespaces hours to the machine, so this is a meter, not a reading.',
      },
      settings: {
        plan: settings.plan,
        planLabel: (PLANS[settings.plan] || PLANS.free).label,
        quotaCoreHours: quota,
        quotaStorageGb: Number(settings.storageGb) || PLANS.free.storageGb,
        idleMinutes,
        cores: coresNow,
        plans: Object.entries(PLANS).map(([id, plan]) => ({ id, label: plan.label, coreHours: plan.coreHours, storageGb: plan.storageGb })),
      },
      session: {
        startedAt: sessionStart,
        elapsedSeconds: Math.max(0, Math.round((at - sessionStart) / 1000)),
        coreHours: round((Math.max(0, at - sessionStart) / 3600000) * coresNow, 3),
        cores: coresNow,
        idleMinutes,
        idleStopsAt: lastActivity + idleMinutes * 60000,
        idleSecondsLeft: idleLeft,
        awake: Boolean(state.lastActivityAt && at - lastActivity < idleMinutes * 60000),
      },
      month: {
        key: state.month,
        resetAt: bounds.end,
        resetsInHours: Math.max(0, Math.round((bounds.end - at) / HOUR)),
        hoursInMonth: round(bounds.hours, 1),
        coreHours: round(coreHours, 2),
        quotaCoreHours: quota,
        remainingCoreHours: round(Math.max(0, quota - coreHours), 2),
        /* The number a person actually wants: how many hours this machine can
           still run before the allowance is gone. */
        machineHoursLeft: round(Math.max(0, quota - coreHours) / coresNow, 1),
        percent: quota ? Math.min(100, round((coreHours / quota) * 100, 1)) : 0,
        projectedCoreHours: round(projectedCoreHours, 1),
        sessions: Number(state.sessions) || 0,
      },
      storage: {
        bytesNow: Number(state.bytesNow) || 0,
        peakBytes: Number(state.peakBytes) || 0,
        gbMonths: round(storedGbMonths, 3),
        quotaGb: Number(settings.storageGb) || PLANS.free.storageGb,
        remainingGb: round(Math.max(0, (Number(settings.storageGb) || PLANS.free.storageGb) - storedGbMonths), 3),
        percent: Number(settings.storageGb)
          ? Math.min(100, round((storedGbMonths / Number(settings.storageGb)) * 100, 1))
          : 0,
        projectedGbMonths: round(projectedGbMonths, 3),
      },
      history: Object.entries(state.history)
        .sort()
        .slice(-HISTORY_MONTHS)
        .map(([key, value]) => ({
          month: key,
          coreHours: round((value.coreSeconds || 0) / 3600, 2),
          gbMonths: round((value.byteSeconds || 0) / 3600 / GB / 730, 3),
        })),
      at,
    };
  }

  return {
    init: load,
    tick,
    touch,
    describe,
    setSettings,
    /** Tests only: read the raw state. */
    _state: () => state,
    TICK_MS,
  };
}

module.exports = {
  createMeter,
  monthKey,
  monthBounds,
  gbMonths,
  PLANS,
  DEFAULT_IDLE_MINUTES,
  TICK_MS,
};
