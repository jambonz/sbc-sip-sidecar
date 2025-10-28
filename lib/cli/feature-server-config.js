const runtimeConfigModule = require('./runtime-config');

function isValidIP(ip) {
  if (!ip || typeof ip !== 'string') return false;

  // IPv4 check
  const ipv4 = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  if (ipv4.test(ip)) return true;

  // IPv6 check (basic patterns)
  const ipv6 = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^::1$|^::$/;
  if (ipv6.test(ip)) return true;

  // IPv6 compressed
  const ipv6Short = new RegExp([
    '^([0-9a-fA-F]{1,4}:)*::([0-9a-fA-F]{1,4}:)*[0-9a-fA-F]{1,4}$',
    '^([0-9a-fA-F]{1,4}:)*::[0-9a-fA-F]{1,4}$',
    '^[0-9a-fA-F]{1,4}::([0-9a-fA-F]{1,4}:)*[0-9a-fA-F]{1,4}$'
  ].join('|'));
  if (ipv6Short.test(ip)) return true;

  return false;
}

async function isDrained(serverIP) {
  if (!isValidIP(serverIP)) {
    return false;
  }

  try {
    const runtimeConfig = runtimeConfigModule.getInstance();
    return await runtimeConfig.isServerDrained(serverIP);
  } catch {
    return false;
  }
}

async function getDrainedServers() {
  try {
    const runtimeConfig = runtimeConfigModule.getInstance();
    return await runtimeConfig.getDrainedFeatureServers();
  } catch {
    return [];
  }
}

async function getActiveServers() {
  try {
    const runtimeConfig = runtimeConfigModule.getInstance();
    return await runtimeConfig.getActiveFeatureServers();
  } catch {
    return [];
  }
}

async function getAvailableServers() {
  try {
    const runtimeConfig = runtimeConfigModule.getInstance();
    return await runtimeConfig.getAvailableFeatureServers();
  } catch {
    return [];
  }
}

async function getAllServersWithStatus() {
  try {
    const runtimeConfig = runtimeConfigModule.getInstance();
    return await runtimeConfig.getAllFeatureServersWithStatus();
  } catch {
    return { servers: [], drained: [] };
  }
}

module.exports = {
  isValidIP,
  isDrained,
  getDrainedServers,
  getActiveServers,
  getAvailableServers,
  getAllServersWithStatus
};
