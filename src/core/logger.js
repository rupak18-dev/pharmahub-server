const noop = () => {};

export const logger = {
  info: (msg) => console.log(`[info] ${msg}`),
  warn: (msg) => console.warn(`[warn] ${msg}`),
  error: (msg, err) => {
    if (err) console.error(`[error] ${msg}`, err);
    else console.error(`[error] ${msg}`);
  },
  debug: (msg) => {
    if (process.env.DEBUG) console.debug(`[debug] ${msg}`);
  },
};

export const stream = {
  write: (line) => logger.info(line.trim()),
};

export function createTestLogger() {
  return { info: noop, warn: noop, error: noop, debug: noop };
}
