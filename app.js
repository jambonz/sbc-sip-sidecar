const assert = require('assert');
const {
  JAMBONES_MYSQL_HOST,
  JAMBONES_MYSQL_USER,
  JAMBONES_MYSQL_PASSWORD,
  JAMBONES_MYSQL_DATABASE,
  JAMBONES_REDIS_SENTINEL_MASTER_NAME,
  JAMBONES_REDIS_SENTINELS,
  JAMBONES_REDIS_HOST,
  DRACHTIO_HOST,
  DRACHTIO_PORT,
  DRACHTIO_SECRET,
  JAMBONES_TIME_SERIES_HOST,
  JAMBONES_LOGLEVEL,
  JAMBONES_MYSQL_PORT,
  JAMBONES_MYSQL_CONNECTION_LIMIT,
  NODE_ENV,
  SBC_PUBLIC_ADDRESS_KEEP_ALIVE_IN_MILISECOND
} = require('./lib/config');

assert.ok(JAMBONES_MYSQL_HOST &&
  JAMBONES_MYSQL_USER &&
  JAMBONES_MYSQL_PASSWORD &&
  JAMBONES_MYSQL_DATABASE, 'missing JAMBONES_MYSQL_XXX env vars');
if (JAMBONES_REDIS_SENTINELS) {
  assert.ok(JAMBONES_REDIS_SENTINEL_MASTER_NAME,
    'missing JAMBONES_REDIS_SENTINEL_MASTER_NAME env var, JAMBONES_REDIS_SENTINEL_PASSWORD env var is optional');
} else {
  assert.ok(JAMBONES_REDIS_HOST, 'missing JAMBONES_REDIS_HOST env var');
}
assert.ok(DRACHTIO_HOST, 'missing DRACHTIO_HOST env var');
assert.ok(DRACHTIO_PORT, 'missing DRACHTIO_PORT env var');
assert.ok(DRACHTIO_SECRET, 'missing DRACHTIO_SECRET env var');
assert.ok(JAMBONES_TIME_SERIES_HOST, 'missing JAMBONES_TIME_SERIES_HOST env var');

const CIDRMatcher = require('cidr-matcher');
const logger = require('pino')({ level: JAMBONES_LOGLEVEL || 'info' });
const Srf = require('drachtio-srf');
const srf = new Srf();
const StatsCollector = require('@jambonz/stats-collector');
const stats = new StatsCollector(logger);
const { initLocals, rejectIpv4, checkCache, checkAccountLimits } = require('./lib/middleware');
const responseTime = require('drachtio-mw-response-time');
const regParser = require('drachtio-mw-registration-parser');
const Registrar = require('@jambonz/mw-registrar');
const digestChallenge = require('@jambonz/digest-utils');
const debug = require('debug')('jambonz:sbc-registrar');
const {
  lookupAuthHook,
  lookupAllVoipCarriers,
  lookupSipGatewaysByCarrier,
  lookupAccountBySipRealm,
  lookupAccountCapacitiesBySid,
  addSbcAddress,
  cleanSbcAddresses,
  updateVoipCarriersRegisterStatus,
  lookupClientByAccountAndUsername,
  lookupSipGatewaysByFilters,
  updateSipGatewayBySid,
  lookupCarrierBySid,
  lookupSystemInformation,
  updateCarrierBySid,
  lookupAccountBySid
} = require('@jambonz/db-helpers')({
  host: JAMBONES_MYSQL_HOST,
  user: JAMBONES_MYSQL_USER,
  port: JAMBONES_MYSQL_PORT || 3306,
  password: JAMBONES_MYSQL_PASSWORD,
  database: JAMBONES_MYSQL_DATABASE,
  connectionLimit: JAMBONES_MYSQL_CONNECTION_LIMIT || 10
}, logger);
const {
  writeAlerts,
  AlertType
} = require('@jambonz/time-series')(logger, {
  host: JAMBONES_TIME_SERIES_HOST,
  commitSize: 50,
  commitInterval: 'test' === NODE_ENV ? 7 : 20
});

const {
  client,
  addKey,
  addKeyNx,
  retrieveKey,
  addToSet,
  removeFromSet,
  isMemberOfSet,
  retrieveSet,
  createEphemeralGateway,
  deleteEphemeralGateway
} = require('@jambonz/realtimedb-helpers')({}, logger);

const interval = SBC_PUBLIC_ADDRESS_KEEP_ALIVE_IN_MILISECOND || 900000; // Default 15 minutes

srf.locals = {
  ...srf.locals,
  logger,
  stats,
  addToSet, removeFromSet, isMemberOfSet, retrieveSet,
  registrar: new Registrar(logger, client),
  dbHelpers: {
    lookupAccountBySid,
    lookupAuthHook,
    lookupAllVoipCarriers,
    lookupSipGatewaysByCarrier,
    lookupAccountBySipRealm,
    lookupAccountCapacitiesBySid,
    updateVoipCarriersRegisterStatus,
    lookupClientByAccountAndUsername,
    lookupSipGatewaysByFilters,
    updateSipGatewayBySid,
    lookupCarrierBySid,
    lookupSystemInformation,
    updateCarrierBySid
  },
  realtimeDbHelpers: {
    client,
    addKey,
    addKeyNx,
    retrieveKey,
    retrieveSet,
    createEphemeralGateway,
    deleteEphemeralGateway
  },
  writeAlerts,
  AlertType
};
const cidrsEnv = process.env.JAMBONES_NETWORK_CIDR || '192.168.0.0/24,172.16.0.0/16,10.0.0.0/8';
const cidrs = cidrsEnv
  .split(',')
  .map((s) => s.trim());
const matcher = new CIDRMatcher(cidrs);

srf.connect({ host: DRACHTIO_HOST, port: DRACHTIO_PORT, secret: DRACHTIO_SECRET });
srf.on('connect', (err, hp, version, localHostports) => {
  if (err) return logger.error({ err }, 'Error connecting to drachtio server');
  logger.info(`connected to drachtio listening on ${hp}, local hostports: ${localHostports}`);

  if (localHostports) {
    const locals = localHostports.split(',');
    for (const hp of locals) {
      const arr = /^(.*)\/(.*):(\d+)$/.exec(hp);
      if (arr && 'tcp' === arr[1] && matcher.contains(arr[2])) {
        const hostport = `${arr[2]}:${arr[3]}`;
        srf.locals.privateSipAddress = hostport;
      }
    }
  }

  // Add SBC Public IP to Database
  srf.locals.sbcPublicIpAddress = {};
  let defaultIp;
  const map = new Map();
  const hostports = hp.split(',');
  for (const hp of hostports) {
    const arr = /^(.*)\/(.*):(\d+)$/.exec(hp);
    if (arr) {
      const ipv4 = arr[2];
      const port = arr[3];
      const addr = map.get(ipv4) || {ipv4};
      switch (arr[1]) {
        case 'udp':
          srf.locals.sbcPublicIpAddress = {
            ...srf.locals.sbcPublicIpAddress,
            udp: `${ipv4}:${port}`
          };
          map.set(ipv4, {...addr, port: port});
          defaultIp = ipv4;
          break;
        case 'tls':
          map.set(ipv4, {...addr, tls_port: port});
          srf.locals.sbcPublicIpAddress = {
            ...srf.locals.sbcPublicIpAddress,
            tls: `${ipv4}:${port}`
          };
          break;
        case 'wss':
          srf.locals.sbcPublicIpAddress = {
            ...srf.locals.sbcPublicIpAddress,
            wss: `${ipv4}:${port}`
          };
          map.set(ipv4, {...addr, wss_port: port});
          break;
      }
    }
  }

  // if drachtio server does not tell us the tls ip and port default to standard 5061
  if (!srf.locals.sbcPublicIpAddress.tls) {
    srf.locals.sbcPublicIpAddress.tls = `${defaultIp}:5061`;
  }

  logger.info({sbcPublicIpAddress: srf.locals.sbcPublicIpAddress}, 'sbc public ip addresses');

  // Function to check if the IP address is in a private subnet (RFC 1918)
  const isPrivateSubnet = (ip) => {
    const [firstOctet, secondOctet] = ip.split('.').map(Number);
    return (
      (firstOctet === 10) || // 10.0.0.0/8
      (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31) || // 172.16.0.0/12
      (firstOctet === 192 && secondOctet === 168) // 192.168.0.0/16
    );
  };

  logger.info({ips: [...map.entries()]}, 'drachtio sip contacts');
  const mapOfPublicAddresses = map.size === 0 ? map : new Map(Array.from(
    map.entries())
    .filter(([key, value]) => !isPrivateSubnet(key)));

  logger.info({ips: [...mapOfPublicAddresses.entries()]}, 'drachtio sip public contacts');

  mapOfPublicAddresses.forEach((addr) => {
    addSbcAddress(addr.ipv4, addr.port, addr.tls_port, addr.wss_port);
    // keep alive for this SBC
    setTimeout(() => {
      addSbcAddress(addr.ipv4, addr.port, addr.tls_port, addr.wss_port);
    }, interval);
  });

  // first start up, clean sbc address
  cleanSbcAddresses();
  setTimeout(() => {
    cleanSbcAddresses();
  }, interval);

  /* start regbot */
  require('./lib/sip-trunk-register')(logger, srf);
  // Start Options bot
  require('./lib/sip-trunk-options-ping')(logger, srf);
});

if (NODE_ENV === 'test') {
  srf.on('error', (err) => {
    logger.info(err, 'Error connecting to drachtio');
  });
}

const rttMetric = (req, res, time) => {
  if (res.cached) {
    stats.histogram('sbc.registration.cached.response_time', time.toFixed(0), [`status:${res.statusCode}`]);
  }
  else {
    stats.histogram('sbc.registration.total.response_time', time.toFixed(0), [`status:${res.statusCode}`]);
  }
};

// middleware
srf.use('register', [
  initLocals,
  responseTime(rttMetric),
  rejectIpv4,
  regParser,
  checkCache,
  checkAccountLimits,
  digestChallenge]);

srf.use('options', [
  initLocals
]);

srf.register(require('./lib/register')({logger}));
srf.options(require('./lib/options')({srf, logger}));

// Start CLI runtime config server with access to srf.locals
require('./lib/cli/runtime-config').initialize(srf.locals, logger);

setInterval(async() => {
  const count = await srf.locals.registrar.getCountOfUsers();
  debug(`count of registered users: ${count}`);
  stats.gauge('sbc.users.count', parseInt(count));
}, 30000);

module.exports = { srf, logger };
