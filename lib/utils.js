function isUacBehindNat(req) {

  // no need for nat handling if wss or tcp being used
  if (req.protocol !== 'udp') return false;

  // let's keep it simple -- if udp, let's crank down the register interval
  return true;
}

function getSipProtocol(req) {
  if (req.getParsedHeader('Via')[0].protocol.toLowerCase().startsWith('wss')) return 'wss';
  if (req.getParsedHeader('Via')[0].protocol.toLowerCase().startsWith('ws')) return 'ws';
  if (req.getParsedHeader('Via')[0].protocol.toLowerCase().startsWith('tcp')) return 'tcp';
  if (req.getParsedHeader('Via')[0].protocol.toLowerCase().startsWith('udp')) return 'udp';
}

function makeBlacklistGatewayKey(key) {
  return `blacklist-sip-gateway:${key}`;
}

async function addSipGatewayToBlacklist(client, logger, sip_gateway_sid, expired) {
  try {
    await client.setex(makeBlacklistGatewayKey(sip_gateway_sid), expired, '');
    logger.info(`addSipGatewayToBlacklist: added  ${sip_gateway_sid} to blacklist`);
  } catch (err) {
    logger.error({err}, `addSipGatewayToBlacklist: Error add  ${sip_gateway_sid} to blacklist`);
  }
}

/* Regex pattern to match valid IPv4 addresses (0.0.0.0 to 255.255.255.255) */
const ipv4Pattern = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

/**
 * Checks if the given input string represents a valid IPv4 address.
 *
 * @param {string} ip - The string to be validated.
 * @returns {boolean} - `true` if the input is a valid IPv4 address, `false` otherwise.
 */
function isValidIPv4(ip) {
  return ipv4Pattern.test(ip);
}

function isValidDomainOrIP(input) {
  const domainRegex = /^(?!:\/\/)([a-zA-Z0-9.-]+)(:\d+)?$/;
  // eslint-disable-next-line max-len
  const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(:\d+)?$/;

  if (domainRegex.test(input) || ipRegex.test(input)) {
    return true;
  }

  return false; // Invalid input
}

const sleepFor = async(ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = {
  isUacBehindNat,
  getSipProtocol,
  addSipGatewayToBlacklist,
  NAT_EXPIRES: 30,
  isValidIPv4,
  isValidDomainOrIP,
  sleepFor
};
