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

    const isIPv4 = /[0-9]{1,3}.[0-9]{1,3}.[0-9]{1,3}.[0-9]{1,3}/.test(gateway.ipv4);
    const transport = gateway.protocol.includes('/') ? gateway.protocol.substring(0, gateway.protocol.indexOf('/')) :
      gateway.protocol;
    this.proxy = `sip:${this.ipv4}${isIPv4 ? `:${this.port}` : ''};transport=${transport}`;
    this.uri = `sip${gateway.protocol.includes('tls') ?
      's' : ''}:${gateway.ipv4}${gateway.port && !gateway.protocol.includes('tls') ? `:${gateway.port}` : ''}`;
  }

  async options(srf) {
    const { updateSipGatewayBySid, lookupCarrierBySid } = srf.locals.dbHelpers;
    const { writeAlerts } = srf.locals;
    try {
      const req = await srf.request({
        uri: this.uri,
        method: 'OPTIONS',
        proxy: this.proxy
      });
      req.on('response', async(res) => {
        if (res.status !== 200) {
          this.logger.info(`Received Options response ${res.status} for ${this.uri}`);
          await updateSipGatewayBySid(this.sip_gateway_sid, {is_active: false});
          const carrier = await lookupCarrierBySid(this.voip_carrier_sid);
          if (carrier) {
            writeAlerts({
              account_sid: carrier.account_sid,
              service_provider_sid: carrier.service_provider_sid,
              message: `Options ping ${this.ipv4}${this.port ? `:${this.port}` : ''};transport=${this.protocol}
 unsuccessfully, received: ${res.status}`
            });
          }
        }
      });
    } catch (err) {
      this.logger.error({ err }, `Error Options ping to ${this.uri}`);
      await updateSipGatewayBySid(this.sip_gateway_sid, {is_active: false});
      const carrier = await lookupCarrierBySid(this.voip_carrier_sid);
      if (carrier) {
        writeAlerts({
          account_sid: carrier.account_sid,
          service_provider_sid: carrier.service_provider_sid,
          message: `Options ping ${this.ipv4}${this.port ? `:${this.port}` : ''};transport=${this.protocol}
 unsuccessfully`
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

      logger.info(`updateSipGatewayOptsBot: start sending Options to ${gws.length} destinations`);
      send_options_gateways.length = 0;
      send_options_gateways.push(...gws);
      for (const g of send_options_gateways) {
        const optsBot = new OptionsBot(logger, g);
        send_options_bots.push(optsBot);
        optsBot.start(srf);
      }
      logger.debug(`updateSipGatewayOptsBot: we have started ${send_options_bots.length} optionsBots`);
    } catch (err) {
      logger.error({ err }, 'updateSipGatewayOptsBot Error');
    }
  };

  setInterval(updateSipGatewayOptsBot.bind(null, logger, srf), (process.env.SEND_OPTIONS_PING_INTERVAL || 60) * 1000);
};
