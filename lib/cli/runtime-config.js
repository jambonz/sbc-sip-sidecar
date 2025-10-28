const net = require('net');

const config = new Map();
const queue = [];
let processing = false;
let logger;

async function runOperation(operation) {
  return new Promise((resolve, reject) => {
    queue.push({ operation, resolve, reject });
    processQueue();
  });
}

async function processQueue() {
  if (processing || queue.length === 0) return;

  processing = true;

  while (queue.length > 0) {
    const { operation, resolve, reject } = queue.shift();
    try {
      const result = await operation();
      resolve(result);
    } catch (err) {
      reject(err);
    }
  }

  processing = false;
}

class RuntimeConfig {
  constructor(srfLocals = null, appLogger = null) {
    this.server = null;
    this.socketPath = process.env.SBC_SOCKET_PATH || '/tmp/sbc-sip-sidecar.sock';
    this.srfLocals = srfLocals;
    if (appLogger) {
      logger = appLogger;
    } else if (!logger) {
      throw new Error('Logger is required for RuntimeConfig');
    }
    this.startServer();
  }

  async set(key, value) {
    return runOperation(() => {
      config.set(key, value);
      logger.info({ key, value }, 'Config updated');
      return { key, value };
    });
  }

  async get(key, defaultValue) {
    return runOperation(() => {
      return config.has(key) ? config.get(key) : defaultValue;
    });
  }

  async addToArray(key, item) {
    return runOperation(() => {
      let arr = config.get(key) || [];

      if (typeof arr === 'string') {
        arr = arr.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      }

      if (!Array.isArray(arr)) arr = [];

      const exists = arr.includes(item);

      if (!exists) {
        arr.push(item);
        config.set(key, arr);
        logger.info({ key, item, array: arr }, 'Added to array');
      }

      return { key, item, array: arr, added: !exists };
    });
  }

  async removeFromArray(key, item) {
    return runOperation(() => {
      let arr = config.get(key) || [];

      if (typeof arr === 'string') {
        arr = arr.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      }

      if (!Array.isArray(arr)) arr = [];

      const originalLength = arr.length;
      arr = arr.filter((existing) => existing !== item);

      if (arr.length !== originalLength) {
        config.set(key, arr);
        logger.info({ key, item, array: arr }, 'Removed from array');
      }

      return { key, item, array: arr, removed: arr.length !== originalLength };
    });
  }

  async getAll() {
    return runOperation(() => Object.fromEntries(config));
  }

  // Helper methods for cleaner code
  checkRedisConnection(requiredMethod) {
    return this.srfLocals && this.srfLocals[requiredMethod];
  }

  sendError(socket, message) {
    socket.write(JSON.stringify({ success: false, error: message }) + '\n');
  }

  sendSuccess(socket, data) {
    socket.write(JSON.stringify({ success: true, ...data }) + '\n');
  }

  getSetNames() {
    const JAMBONES_CLUSTER_ID = process.env.JAMBONES_CLUSTER_ID;
    return {
      activeFs: `${(JAMBONES_CLUSTER_ID || 'default')}:active-fs`,
      drainedFs: `${(JAMBONES_CLUSTER_ID || 'default')}:drained-fs`
    };
  }

  // Feature server utility methods
  async isServerDrained(serverIP) {
    if (!this.checkRedisConnection('isMemberOfSet')) {
      return false;
    }

    try {
      const { drainedFs } = this.getSetNames();
      return await this.srfLocals.isMemberOfSet(drainedFs, serverIP);
    } catch {
      return false;
    }
  }

  async getDrainedFeatureServers() {
    if (!this.checkRedisConnection('retrieveSet')) {
      return [];
    }

    try {
      const { drainedFs } = this.getSetNames();
      const servers = await this.srfLocals.retrieveSet(drainedFs);
      return servers || [];
    } catch {
      return [];
    }
  }

  async getActiveFeatureServers() {
    if (!this.checkRedisConnection('retrieveSet')) {
      return [];
    }

    try {
      const { activeFs } = this.getSetNames();
      const servers = await this.srfLocals.retrieveSet(activeFs);
      return servers || [];
    } catch {
      return [];
    }
  }

  async getAvailableFeatureServers() {
    try {
      const [active, drained] = await Promise.all([
        this.getActiveFeatureServers(),
        this.getDrainedFeatureServers()
      ]);

      const drainedSet = new Set(drained);
      return active.filter((server) => !drainedSet.has(server));
    } catch {
      return [];
    }
  }

  async getAllFeatureServersWithStatus() {
    try {
      const [active, drained] = await Promise.all([
        this.getActiveFeatureServers(),
        this.getDrainedFeatureServers()
      ]);

      const drainedSet = new Set(drained);
      const servers = active.map((server) => ({
        server,
        status: drainedSet.has(server) ? 'drained' : 'active'
      }));

      return { servers, drained };
    } catch {
      return { servers: [], drained: [] };
    }
  }

  async handleFeatureServerDrain(socket, server) {
    if (!this.checkRedisConnection('addToSet')) {
      return this.sendError(socket, 'Redis connection not available');
    }

    const { isValidIP } = require('./feature-server-config');
    if (!isValidIP(server)) {
      return this.sendError(socket, `Invalid IP address: ${server}`);
    }

    try {
      const { drainedFs } = this.getSetNames();
      await this.srfLocals.addToSet(drainedFs, server);
      const drainedServers = await this.srfLocals.retrieveSet(drainedFs);
      this.sendSuccess(socket, {
        action: 'drain',
        server,
        drained: drainedServers || []
      });
    } catch (err) {
      logger.error({ err }, 'Error draining server');
      this.sendError(socket, 'Failed to drain server');
    }
  }

  async handleFeatureServerUndrain(socket, server) {
    if (!this.checkRedisConnection('removeFromSet')) {
      return this.sendError(socket, 'Redis connection not available');
    }

    const { isValidIP } = require('./feature-server-config');
    if (!isValidIP(server)) {
      return this.sendError(socket, `Invalid IP address: ${server}`);
    }

    try {
      const { drainedFs } = this.getSetNames();
      await this.srfLocals.removeFromSet(drainedFs, server);
      const drainedServers = await this.srfLocals.retrieveSet(drainedFs);
      this.sendSuccess(socket, {
        action: 'undrain',
        server,
        drained: drainedServers || []
      });
    } catch (err) {
      logger.error({ err }, 'Error undraining server');
      this.sendError(socket, 'Failed to undrain server');
    }
  }

  async handleFeatureServerDrained(socket) {
    try {
      const drainedServers = await this.getDrainedFeatureServers();
      this.sendSuccess(socket, { drained: drainedServers });
    } catch (err) {
      logger.error({ err }, 'Error retrieving drained servers');
      this.sendError(socket, 'Failed to retrieve drained servers');
    }
  }

  async handleFeatureServerList(socket) {
    try {
      const result = await this.getAllFeatureServersWithStatus();
      this.sendSuccess(socket, result);
    } catch (err) {
      logger.error({ err }, 'Error listing servers');
      this.sendError(socket, 'Failed to list servers');
    }
  }

  async handleFeatureServerAvailable(socket) {
    try {
      const availableServers = await this.getAvailableFeatureServers();
      this.sendSuccess(socket, { available: availableServers });
    } catch (err) {
      logger.error({ err }, 'Error retrieving available servers');
      this.sendError(socket, 'Failed to retrieve available servers');
    }
  }

  startServer() {
    try {
      require('fs').unlinkSync(this.socketPath);
    } catch {
      // socket file doesn't exist, that's fine
    }

    this.server = net.createServer((socket) => {
      let buffer = '';

      socket.on('data', (data) => {
        buffer += data.toString();

        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (line.trim()) {
            this.handleCommand(socket, line.trim());
          }
        }
      });

      socket.on('error', (err) => {
        logger.error({ err }, 'Socket error');
      });
    });

    this.server.listen(this.socketPath, () => {
      logger.info({ socketPath: this.socketPath }, 'CLI server started');
      require('fs').chmodSync(this.socketPath, 0o600);
    });

    this.server.on('error', (err) => {
      logger.error({ err }, 'Server error');
    });
  }

  async handleCommand(socket, jsonString) {
    try {
      const cmd = JSON.parse(jsonString);

      switch (cmd.action) {
        case 'set':
          const setResult = await this.set(cmd.key, cmd.value);
          this.sendSuccess(socket, setResult);
          break;

        case 'get':
          const value = await this.get(cmd.key);
          this.sendSuccess(socket, { key: cmd.key, value });
          break;

        case 'add':
          const addResult = await this.addToArray(cmd.key, cmd.item);
          this.sendSuccess(socket, addResult);
          break;

        case 'remove':
          const removeResult = await this.removeFromArray(cmd.key, cmd.item);
          this.sendSuccess(socket, removeResult);
          break;

        case 'list':
          const allConfig = await this.getAll();
          this.sendSuccess(socket, { config: allConfig });
          break;

        case 'fs-drain':
          await this.handleFeatureServerDrain(socket, cmd.server);
          break;

        case 'fs-undrain':
          await this.handleFeatureServerUndrain(socket, cmd.server);
          break;

        case 'fs-drained':
          await this.handleFeatureServerDrained(socket);
          break;

        case 'fs-list':
          await this.handleFeatureServerList(socket);
          break;

        case 'fs-available':
          await this.handleFeatureServerAvailable(socket);
          break;

        default:
          this.sendError(socket, 'Unknown action');
      }
    } catch (err) {
      logger.error({ err, command: jsonString }, 'Command error');
      this.sendError(socket, 'Invalid command');
    }
  }

  shutdown() {
    if (this.server) {
      this.server.close();
      try {
        require('fs').unlinkSync(this.socketPath);
      } catch {
        // ignore
      }
    }
  }
}

let runtimeConfig = null;

function createInstance(srfLocals = null, appLogger = null) {
  const instance = new RuntimeConfig(srfLocals, appLogger);
  process.on('SIGINT', () => instance.shutdown());
  process.on('SIGTERM', () => instance.shutdown());
  return instance;
}

function initialize(srfLocals, appLogger) {
  if (!appLogger) {
    throw new Error('Logger is required for RuntimeConfig initialization');
  }
  if (!runtimeConfig) {
    runtimeConfig = createInstance(srfLocals, appLogger);
  } else {
    // Update existing instance with srfLocals and logger
    runtimeConfig.srfLocals = srfLocals;
    logger = appLogger;
  }

  return runtimeConfig;
}

function getInstance() {
  if (!runtimeConfig) {
    throw new Error('RuntimeConfig not initialized. Call initialize() first with logger.');
  }
  return runtimeConfig;
}

module.exports = {
  initialize,
  getInstance
};
