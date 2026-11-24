const debug = require('debug')('jambonz:sbc-server-control');
const { JAMBONES_SERVER_CONTROL, JAMBONES_CLUSTER_ID } = require('../config');

/* SIP header a client sets (X-Jambonz-Discover: true) to request a topology discovery response */
const DISCOVER_HEADER = 'X-Jambonz-Discover';

/**
 * Whether the server-control features are enabled.
 * Gated behind the JAMBONES_SERVER_CONTROL env var; treats the usual truthy
 * strings ('1', 'true', 'yes') as enabled, everything else as disabled.
 */
const isEnabled = () => {
  if (!JAMBONES_SERVER_CONTROL) return false;
  return /^(1|true|yes)$/i.test(`${JAMBONES_SERVER_CONTROL}`.trim());
};

/* redis set names holding the active servers of each type for this cluster */
const _setNames = () => {
  const prefix = JAMBONES_CLUSTER_ID || 'default';
  return {
    featureServers: `${prefix}:active-fs`,
    sipServers: `${prefix}:active-sip`,
    rtpServers: `${prefix}:active-rtp`
  };
};

/**
 * Return true if the request is a discovery request, i.e. it carries the
 * `X-Jambonz-Discover: true` header. Header presence/value is checked
 * case-insensitively.
 */
const isDiscoverRequest = (req) => {
  if (!req.has(DISCOVER_HEADER)) return false;
  return /^true$/i.test(`${req.get(DISCOVER_HEADER)}`.trim());
};

/**
 * Read the database schema version from the schema_version table.  This is the
 * version of the jambonz schema, not of any server's software: a release that
 * changes no tables leaves it unchanged (see featureServerVersions).
 * A failure here must not fail discovery, so it resolves to null on any error.
 * @param {object} pool - mysql connection pool (may be undefined in tests)
 * @returns {Promise<string|null>}
 */
const _lookupJambonzVersion = (pool) => new Promise((resolve) => {
  if (!pool) return resolve(null);
  pool.query('SELECT version FROM schema_version', (err, results) => {
    if (err) {
      debug({err}, 'failed reading schema_version');
      return resolve(null);
    }
    resolve(results && results.length ? results[0].version : null);
  });
});

/**
 * Read each feature server's self-reported software version (X-FS-Version on its
 * status ping) from the shared `<active-fs>:version` hash, limited to current members.
 * Servers that don't report a version (older feature-server releases) are absent.
 * A failure here must not fail discovery, so it resolves to {} on any error.
 */
const _lookupFsVersions = async(client, setName, members) => {
  if (!client || !members.length) return {};
  try {
    const all = await client.hgetall(`${setName}:version`) || {};
    return Object.fromEntries(members.filter((m) => all[m]).map((m) => [m, all[m]]));
  } catch (err) {
    debug({err}, 'failed reading feature server versions');
    return {};
  }
};

/**
 * Read the current cluster topology from redis (the IPs of the feature
 * servers, SIP servers and RTP servers), each feature server's reported
 * software version, the database schema version (reported as jambonzVersion,
 * its name since the first release of this response) and the drachtio server
 * version (captured on connect).
 * @param {object} srf - drachtio srf instance (uses srf.locals.retrieveSet, srf.locals.pool,
 *   srf.locals.realtimeDbHelpers.client)
 * @returns {Promise<{jambonzVersion: string|null, drachtioVersion: string|null,
 *   featureServers: string[], featureServerVersions: Object<string, string>,
 *   sipServers: string[], rtpServers: string[]}>}
 */
const discoverServers = async(srf) => {
  const { retrieveSet, pool, drachtioVersion, realtimeDbHelpers } = srf.locals;
  const { featureServers, sipServers, rtpServers } = _setNames();

  const [fs, sip, rtp, jambonzVersion] = await Promise.all([
    retrieveSet(featureServers),
    retrieveSet(sipServers),
    retrieveSet(rtpServers),
    _lookupJambonzVersion(pool)
  ]);
  const featureServerVersions = await _lookupFsVersions(realtimeDbHelpers && realtimeDbHelpers.client,
    featureServers, fs || []);

  const topology = {
    jambonzVersion,
    drachtioVersion: drachtioVersion || null,
    featureServers: fs || [],
    featureServerVersions,
    sipServers: sip || [],
    rtpServers: rtp || []
  };
  debug({topology}, 'discovered cluster topology from redis');
  return topology;
};

module.exports = {
  DISCOVER_HEADER,
  isEnabled,
  isDiscoverRequest,
  discoverServers
};
