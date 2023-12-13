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

module.exports = {
  isUacBehindNat,
  getSipProtocol,
  addSipGatewayToBlacklist,
  NAT_EXPIRES: 30
};
