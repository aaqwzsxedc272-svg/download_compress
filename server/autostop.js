'use strict';
/**
 * Stop the machine once the queue is empty, so a metered host (GitHub
 * Codespaces, a paid instance) does not keep billing after the work is done.
 *
 * Off by default. Turn it on per run with AUTO_STOP_WHEN_IDLE=1, or from the app
 * with POST /api/auto-stop { "enabled": true }. The stop is scheduled, not
 * immediate: a running job's result still has to be downloaded or share-linked,
 * so there is a countdown that a new job (or a click) cancels.
 *
 * The command is chosen once, at boot:
 *   AUTO_STOP_COMMAND   used verbatim if set
 *   CODESPACE_NAME      ->  gh codespace stop -c <name>
 *   otherwise           ->  nothing is configured and the toggle refuses
 */

const { spawn } = require('node:child_process');

const state = {
  enabled: process.env.AUTO_STOP_WHEN_IDLE === '1',
  delaySeconds: Math.max(10, Number(process.env.AUTO_STOP_DELAY_SECONDS) || 120),
  pendingAt: null,
  timer: null,
  reason: null,
  lastStopAt: null,
  lastError: null,
};

function resolveCommand() {
  if (process.env.AUTO_STOP_COMMAND) {
    return { command: process.env.AUTO_STOP_COMMAND, label: process.env.AUTO_STOP_COMMAND };
  }
  if (process.env.CODESPACE_NAME) {
    return {
      command: `gh codespace stop -c ${process.env.CODESPACE_NAME}`,
      label: `stop codespace ${process.env.CODESPACE_NAME}`,
    };
  }
  return null;
}

const command = resolveCommand();

const configured = () => Boolean(command);

function clearTimer() {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

function cancel(reason) {
  if (!state.pendingAt) return false;
  clearTimer();
  state.pendingAt = null;
  state.reason = null;
  console.log(`[auto-stop] cancelled${reason ? ` (${reason})` : ''}`);
  return true;
}

function runStop() {
  state.pendingAt = null;
  state.timer = null;
  state.lastStopAt = Date.now();
  console.log(`[auto-stop] running: ${command.command}`);
  try {
    const child = spawn(command.command, {
      shell: true,
      detached: true,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.unref();
    child.on('error', (err) => {
      state.lastError = err.message;
      console.error('[auto-stop] failed:', err.message);
    });
  } catch (err) {
    state.lastError = err.message;
    console.error('[auto-stop] failed:', err.message);
  }
}

/** Schedule a stop unless one is already pending or the feature is off. */
function schedule(reason) {
  if (!state.enabled || !configured()) return false;
  if (state.pendingAt) return true;
  state.reason = reason || null;
  state.pendingAt = Date.now() + state.delaySeconds * 1000;
  state.timer = setTimeout(runStop, state.delaySeconds * 1000);
  if (state.timer.unref) state.timer.unref();
  console.log(`[auto-stop] stopping in ${state.delaySeconds}s unless another job starts`);
  return true;
}

function enable(next) {
  state.enabled = Boolean(next);
  if (!state.enabled) cancel('switched off');
  return state.enabled;
}

function status() {
  return {
    supported: configured(),
    command: command ? command.label : null,
    enabled: state.enabled,
    delaySeconds: state.delaySeconds,
    stopsAt: state.pendingAt,
    reason: state.reason,
    lastStopAt: state.lastStopAt,
    lastError: state.lastError,
  };
}

module.exports = { status, enable, schedule, cancel, configured, command, state };
