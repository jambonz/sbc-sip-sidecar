const net = require('net');
const logger = require('pino')({ level: process.env.JAMBONES_LOGLEVEL || 'info' });

const config = new Map();
const queue = [];
let processing = false;

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
  constructor() {
    this.server = null;
    this.socketPath = process.env.SBC_SOCKET_PATH || '/tmp/sbc-sip-sidecar.sock';
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
      let result;

      switch (cmd.action) {
        case 'set':
          result = await this.set(cmd.key, cmd.value);
          socket.write(JSON.stringify({ success: true, ...result }) + '\n');
          break;

        case 'get':
          const value = await this.get(cmd.key);
          socket.write(JSON.stringify({ success: true, key: cmd.key, value }) + '\n');
          break;

        case 'add':
          result = await this.addToArray(cmd.key, cmd.item);
          socket.write(JSON.stringify({ success: true, ...result }) + '\n');
          break;

        case 'remove':
          result = await this.removeFromArray(cmd.key, cmd.item);
          socket.write(JSON.stringify({ success: true, ...result }) + '\n');
          break;

        case 'fs-drain':
          result = await this.addToArray('drainedFeatureServers', cmd.server);
          // Check if it's actually a valid IP by using feature-server-config validation
          const fsConfig = require('./feature-server-config');
          if (!fsConfig.isValidIP(cmd.server)) {
            socket.write(JSON.stringify({
              success: false,
              error: `Invalid IP address: ${cmd.server}`
            }) + '\n');
            break;
          }
          socket.write(JSON.stringify({
            success: true,
            action: 'drain',
            server: cmd.server,
            drained: result.array
          }) + '\n');
          break;

        case 'fs-undrain':
          const fsConfigUndrain = require('./feature-server-config');
          if (!fsConfigUndrain.isValidIP(cmd.server)) {
            socket.write(JSON.stringify({
              success: false,
              error: `Invalid IP address: ${cmd.server}`
            }) + '\n');
            break;
          }
          result = await this.removeFromArray('drainedFeatureServers', cmd.server);
          socket.write(JSON.stringify({
            success: true,
            action: 'undrain',
            server: cmd.server,
            drained: result.array
          }) + '\n');
          break;

        case 'fs-drained':
          const drained = await this.get('drainedFeatureServers', []);
          const drainedArray = Array.isArray(drained) ? drained :
            typeof drained === 'string' ?
              drained.split(',').map((s) => s.trim()).filter((s) => s.length > 0) : [];
          socket.write(JSON.stringify({ success: true, drained: drainedArray }) + '\n');
          break;

        case 'fs-list':
          const allServers = await this.get('allFeatureServers', []);
          const drainedList = await this.get('drainedFeatureServers', []);
          const drainedSet = new Set(Array.isArray(drainedList) ? drainedList :
            typeof drainedList === 'string' ?
              drainedList.split(',').map((s) => s.trim()).filter((s) => s.length > 0) : []);

          const servers = Array.isArray(allServers) ? allServers.map((server) => ({
            server,
            status: drainedSet.has(server) ? 'drained' : 'active'
          })) : [];

          socket.write(JSON.stringify({
            success: true,
            servers,
            drained: Array.from(drainedSet)
          }) + '\n');
          break;

        case 'list':
          const allConfig = await this.getAll();
          socket.write(JSON.stringify({ success: true, config: allConfig }) + '\n');
          break;

        default:
          socket.write(JSON.stringify({ error: 'Unknown action' }) + '\n');
      }
    } catch (err) {
      logger.error({ err, command: jsonString }, 'Command error');
      socket.write(JSON.stringify({ error: 'Invalid command' }) + '\n');
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

const runtimeConfig = new RuntimeConfig();

process.on('SIGINT', () => runtimeConfig.shutdown());
process.on('SIGTERM', () => runtimeConfig.shutdown());

module.exports = runtimeConfig;
