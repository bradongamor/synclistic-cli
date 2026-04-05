const chalk = require('chalk');

const LOG_LEVELS = {
  DEBUG: 0,
  VERBOSE: 1,
  INFO: 2,
  WARN: 3,
  ERROR: 4
};

// Read environment variables with defaults
function getEnvConfig() {
  return {
    level: LOG_LEVELS[process.env.SYNCLISTIC_LOG_LEVEL] ?? LOG_LEVELS.INFO,
    timestamp: process.env.SYNCLISTIC_LOG_TIMESTAMP === 'true',
    bufferSize: parseInt(process.env.SYNCLISTIC_LOG_BUFFER_SIZE) || 1000,
    flushInterval: parseInt(process.env.SYNCLISTIC_LOG_FLUSH_INTERVAL) || 100
  };
}

class AsyncQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.drainPromise = null;
    this.drainResolve = null;
  }

  enqueue(fn) {
    this.queue.push(fn);
    this.process();
  }

  async process() {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const fn = this.queue.shift();
      try {
        await fn();
      } catch (err) {
        console.error('Error processing log:', err);
      }
    }

    this.processing = false;
    if (this.drainResolve) {
      this.drainResolve();
      this.drainPromise = null;
      this.drainResolve = null;
    }
  }

  async drain() {
    if (this.queue.length === 0) return Promise.resolve();
    if (!this.drainPromise) {
      this.drainPromise = new Promise(resolve => {
        this.drainResolve = resolve;
      });
    }
    return this.drainPromise;
  }
}

class Logger {
  constructor(options = {}) {
    const envConfig = getEnvConfig();
    this.options = {
      level: envConfig.level,
      format: '[{type}] {message}',
      timestamp: envConfig.timestamp,
      destinations: ['console'],
      bufferSize: envConfig.bufferSize,
      flushInterval: envConfig.flushInterval,
      ...options  // Allow options to override environment variables
    };
    this.queue = new AsyncQueue();
    this.messageCount = 0;
    this.setupAutoFlush();
  }

  setupAutoFlush() {
    if (this.options.flushInterval > 0) {
      const timer = setInterval(() => {
        this.flush();
      }, this.options.flushInterval);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
    }
  }

  async flush() {
    await this.queue.drain();
  }

  formatMessage(objectType, message, level) {
    const time = this.options.timestamp ? `${new Date().toISOString()} ` : '';
    return `${time}${this.options.format.replace('{type}', objectType).replace('{message}', message)}`;
  }

  shouldLog(level) {
    return level >= this.options.level;
  }

  queueLog(fn) {
    this.messageCount++;
    this.queue.enqueue(fn);
    
    // Force flush if buffer is full
    if (this.messageCount >= this.options.bufferSize) {
      this.flush();
      this.messageCount = 0;
    }
  }

  log(objectType, message, level = LOG_LEVELS.INFO) {
    if (!this.shouldLog(level)) return;
    this.queueLog(async () => {
      console.log(this.formatMessage(objectType, message, level));
    });
  }

  verbose(objectType, messageFn) {
    if (!this.shouldLog(LOG_LEVELS.VERBOSE)) return;
    // Capture messageFn in closure to evaluate it only when needed
    this.queueLog(async () => {
      const message = typeof messageFn === 'function' ? messageFn() : messageFn;
      console.log(chalk.gray(this.formatMessage(objectType, message, LOG_LEVELS.VERBOSE)));
    });
  }

  info(objectType, message) {
    if (!this.shouldLog(LOG_LEVELS.INFO)) return;
    this.queueLog(async () => {
      console.log(chalk.blue(this.formatMessage(objectType, message, LOG_LEVELS.INFO)));
    });
  }

  success(objectType, message) {
    if (!this.shouldLog(LOG_LEVELS.INFO)) return;
    this.queueLog(async () => {
      console.log(chalk.green(this.formatMessage(objectType, message, LOG_LEVELS.INFO)));
    });
  }

  warn(objectType, message) {
    if (!this.shouldLog(LOG_LEVELS.WARN)) return;
    this.queueLog(async () => {
      console.log(chalk.yellow(this.formatMessage(objectType, message, LOG_LEVELS.WARN)));
    });
  }

  error(objectType, message) {
    if (!this.shouldLog(LOG_LEVELS.ERROR)) return;
    // Errors are processed immediately, not queued
    console.error(chalk.red(this.formatMessage(objectType, message, LOG_LEVELS.ERROR)));
  }

  counts(objectType, sourceName, sourceCount, destName, destCount) {
    this.log(objectType, `Source store (${sourceName}): ${sourceCount} items`);
    this.log(objectType, `Destination store (${destName}): ${destCount} items`);
  }

  operation(objectType, action, title, handle) {
    const message = handle ? `${action}: ${title} (${handle})` : `${action}: ${title}`;
    this.log(objectType, message);
  }

  completed(objectType, createdCount = 0, updatedCount = 0, deletedCount = 0) {
    const parts = [];
    if (createdCount > 0) parts.push(`${createdCount} created`);
    if (updatedCount > 0) parts.push(`${updatedCount} updated`);
    if (deletedCount > 0) parts.push(`${deletedCount} deleted`);
    
    let message = `Sync completed`;
    if (parts.length > 0) {
      message += ` - ${parts.join(', ')}`;
    } else {
      message += ` - No changes made.`;
    }
    this.success(objectType, message);
  }

  failed(objectType, err) {
    const message = err.message || err;
    this.error(objectType, `Sync failed: ${message}`);
  }

  setLevel(level) {
    this.options.level = level;
  }

  setFormat(format) {
    this.options.format = format;
  }

  enableTimestamp(enable = true) {
    this.options.timestamp = enable;
  }
}

// Create a default instance
const defaultLogger = new Logger();

// Export both the class and a default instance
module.exports = {
  Logger,
  default: defaultLogger,
  LOG_LEVELS,
  // Proxy the default methods for backward compatibility
  setVerbose: (verbose) => defaultLogger.setLevel(verbose ? LOG_LEVELS.VERBOSE : LOG_LEVELS.INFO),
  log: (objectType, message) => defaultLogger.log(objectType, message),
  verbose: (objectType, message) => defaultLogger.verbose(objectType, message),
  info: (objectType, message) => defaultLogger.info(objectType, message),
  success: (objectType, message) => defaultLogger.success(objectType, message),
  warn: (objectType, message) => defaultLogger.warn(objectType, message),
  error: (objectType, message) => defaultLogger.error(objectType, message),
  counts: (objectType, sourceName, sourceCount, destName, destCount) => 
    defaultLogger.counts(objectType, sourceName, sourceCount, destName, destCount),
  operation: (objectType, action, title, handle) => 
    defaultLogger.operation(objectType, action, title, handle),
  completed: (objectType, created, updated, deleted) =>
    defaultLogger.completed(objectType, created, updated, deleted),
  failed: (objectType, err) => defaultLogger.failed(objectType, err),
  flush: async () => await defaultLogger.flush()
}; 