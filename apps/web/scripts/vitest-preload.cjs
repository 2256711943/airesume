const childProcess = require('node:child_process');

const originalExec = childProcess.exec;

function isNetUseCommand(command) {
  return typeof command === 'string' && command.trim().toLowerCase() === 'net use';
}

function resolveCallback(options, callback) {
  if (typeof options === 'function') {
    return options;
  }

  return callback;
}

function createDisabledProcess() {
  return {
    pid: 0,
    stdin: null,
    stdout: null,
    stderr: null,
    kill() {
      return false;
    },
    on() {
      return this;
    },
    once() {
      return this;
    },
    removeListener() {
      return this;
    },
  };
}

childProcess.exec = function patchedExec(command, options, callback) {
  if (isNetUseCommand(command)) {
    const done = resolveCallback(options, callback);

    if (typeof done === 'function') {
      process.nextTick(() => {
        done(new Error('net use is disabled for Vitest preload'), '', '');
      });
    }

    return createDisabledProcess();
  }

  return originalExec.call(this, command, options, callback);
};
