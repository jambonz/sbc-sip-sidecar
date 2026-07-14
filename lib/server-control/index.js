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
 * Read the current cluster topology from redis: the IPs of the feature
 * servers, SIP servers and RTP servers.
 * @param {object} srf - drachtio srf instance (uses srf.locals.retrieveSet)
 * @returns {Promise<{featureServers: string[], sipServers: string[], rtpServers: string[]}>}
 */
const discoverServers = async(srf) => {
  const { retrieveSet } = srf.locals;
  const { featureServers, sipServers, rtpServers } = _setNames();

  const [fs, sip, rtp] = await Promise.all([
    retrieveSet(featureServers),
    retrieveSet(sipServers),
    retrieveSet(rtpServers)
  ]);

  const topology = {
    featureServers: fs || [],
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
