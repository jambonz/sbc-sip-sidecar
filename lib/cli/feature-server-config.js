const runtimeConfig = require('./runtime-config');

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

async function getDrainedServers() {
  const drained = await runtimeConfig.get('drainedFeatureServers');

  if (!drained) return [];

  if (typeof drained === 'string') {
    return drained.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  }

  if (Array.isArray(drained)) return drained;

  return [];
}

async function isDrained(serverIP) {
  const drained = await getDrainedServers();
  return drained.includes(serverIP);
}

async function drainServer(serverIP) {
  if (!isValidIP(serverIP)) {
    return {
      added: false,
      array: await getDrainedServers(),
      error: `Invalid IP: ${serverIP}`
    };
  }

  return await runtimeConfig.addToArray('drainedFeatureServers', serverIP);
}

async function undrainServer(serverIP) {
  if (!isValidIP(serverIP)) {
    return {
      removed: false,
      array: await getDrainedServers(),
      error: `Invalid IP: ${serverIP}`
    };
  }

  return await runtimeConfig.removeFromArray('drainedFeatureServers', serverIP);
}

async function setDrainedServers(servers) {
  let serverList = [];

  if (typeof servers === 'string') {
    serverList = servers.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  } else if (Array.isArray(servers)) {
    serverList = servers;
  } else {
    return {
      key: 'drainedFeatureServers',
      value: await getDrainedServers(),
      error: 'Invalid format'
    };
  }

  // Check all IPs are valid
  const badIPs = serverList.filter((ip) => !isValidIP(ip));
  if (badIPs.length > 0) {
    return {
      key: 'drainedFeatureServers',
      value: await getDrainedServers(),
      error: `Invalid IPs: ${badIPs.join(', ')}`
    };
  }

  return await runtimeConfig.set('drainedFeatureServers', serverList);
}

module.exports = {
  getDrainedServers,
  isDrained,
  drainServer,
  undrainServer,
  setDrainedServers,
  isValidIP,
  runtimeConfig,

  // Legacy names for backward compatibility
  getDrainedFeatureServers: getDrainedServers,
  isFeatureServerDrained: isDrained,
  drainFeatureServer: drainServer,
  undrainFeatureServer: undrainServer,
  setDrainedFeatureServers: setDrainedServers
};
