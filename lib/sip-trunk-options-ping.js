const { addSipGatewayToBlacklist } = require('./utils');

const send_options_gateways = [];
const send_options_bots = [];

class OptionsBot {
  constructor(logger, gateway) {
    this.logger = logger;
    this.sip_gateway_sid = gateway.sip_gateway_sid;
    this.voip_carrier_sid = gateway.voip_carrier_sid;
    this.ipv4 = gateway.ipv4;
    this.port = gateway.port;
    this.protocol = gateway.protocol;
    this.expiry = (process.env.SEND_OPTIONS_PING_INTERVAL || 60);

    const useSipsScheme = gateway.protocol.includes('tls') && gateway.use_sips_scheme;
    const isIPv4 = /[0-9]{1,3}.[0-9]{1,3}.[0-9]{1,3}.[0-9]{1,3}/.test(gateway.ipv4);
    const transport = gateway.protocol.includes('/') ? gateway.protocol.substring(0, gateway.protocol.indexOf('/')) :
      gateway.protocol;
    this.proxy = `sip:${this.ipv4}${isIPv4 ? `:${this.port}` : ''};transport=${transport}`;
    this.uri = `sip${useSipsScheme ?
      's' : ''}:${gateway.ipv4}${gateway.port && !useSipsScheme ? `:${gateway.port}` : ''}`;
  }

  async options(srf) {
    const { lookupCarrierBySid } = srf.locals.dbHelpers;
    const { writeAlerts, logger, realtimeDbHelpers } = srf.locals;
    try {
      const req = await srf.request({
        uri: this.uri,
        method: 'OPTIONS',
        proxy: this.proxy
      });
      req.on('response', async(res) => {
        if (res.status !== 200) {
          this.logger.info(`Received Options response ${res.status} for ${this.uri}`);
          await addSipGatewayToBlacklist(realtimeDbHelpers.client, logger, this.sip_gateway_sid, this.expiry);
          const carrier = await lookupCarrierBySid(this.voip_carrier_sid);
          if (carrier) {
            writeAlerts({
              account_sid: carrier.account_sid,
              service_provider_sid: carrier.service_provider_sid,
              // eslint-disable-next-line max-len
              message: `Options ping ${this.ipv4}${this.port ? `:${this.port}` : ''};transport=${this.protocol} unsuccessfully, received: ${res.status}`
            });
          }
        }
      });
    } catch (err) {
      this.logger.error({ err }, `Error Options ping to ${this.uri}`);
      await addSipGatewayToBlacklist(realtimeDbHelpers.client, logger, this.sip_gateway_sid, this.expiry);
      const carrier = await lookupCarrierBySid(this.voip_carrier_sid);
      if (carrier) {
        writeAlerts({
          account_sid: carrier.account_sid,
          service_provider_sid: carrier.service_provider_sid,
          // eslint-disable-next-line max-len
          message: `Options ping ${this.ipv4}${this.port ? `:${this.port}` : ''};transport=${this.protocol} unsuccessfully, error: ${err}`
        });
      }
    }
  }
}

module.exports = async(logger, srf) => {
  const updateSipGatewayOptsBot = async(logger, srf) => {
    try {

      const { lookupSipGatewaysByFilters } = srf.locals.dbHelpers;
      const gws = await lookupSipGatewaysByFilters({send_options_ping: true, outbound: true, is_active: true});

      if (gws.length > 0) {
        logger.debug(`updateSipGatewayOptsBot: sending OPTIONS ping to ${gws.length} gateways`);
        send_options_gateways.length = 0;
        send_options_gateways.push(...gws);
        for (const g of send_options_gateways) {
          const optsBot = new OptionsBot(logger, g);
          send_options_bots.push(optsBot);
          optsBot.options(srf);
        }
        logger.debug(`updateSipGatewayOptsBot: we have started ${send_options_bots.length} optionsBots`);
      }
    } catch (err) {
      logger.error({ err }, 'updateSipGatewayOptsBot Error');
    }
  };

  setInterval(updateSipGatewayOptsBot.bind(null, logger, srf), (process.env.SEND_OPTIONS_PING_INTERVAL || 60) * 1000);
};
