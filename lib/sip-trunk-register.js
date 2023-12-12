const debug = require('debug')('jambonz:sbc-registrar');
const assert = require('assert');
const short = require('short-uuid');
const DEFAULT_EXPIRES = 3600;
const MAX_INITIAL_DELAY = 15;
const REGBOT_STATUS_CHECK_INTERVAL = 60;
const regbotKey = `${(process.env.JAMBONES_CLUSTER_ID || 'default')}:regbot-token`;
const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let initialized = false;

const regbots = [];
const carriers = [];
const gateways = [];
const send_options_gateways = [];
const send_options_bots = [];

function pickRelevantCarrierProperties(c) {
  return {
    voip_carrier_sid: c.voip_carrier_sid,
    requires_register: c.requires_register,
    is_active: c.is_active,
    register_username: c.register_username,
    register_password: c.register_password,
    register_sip_realm: c.register_sip_realm,
    register_from_user: c.register_from_user,
    register_from_domain: c.register_from_domain,
    register_public_ip_in_contact: c.register_public_ip_in_contact
  };
}

class Regbot {
  constructor(logger, opts) {
    this.logger = logger;

    ['ipv4', 'port', 'username', 'password', 'sip_realm', 'protocol'].forEach((prop) => this[prop] = opts[prop]);

    this.voip_carrier_sid = opts.voip_carrier_sid;
    this.username = opts.username;
    this.password = opts.password;
    this.sip_realm = opts.sip_realm || opts.ipv4;
    this.ipv4 = opts.ipv4;
    this.port = opts.port;
    this.use_public_ip_in_contact = opts.use_public_ip_in_contact || process.env.JAMBONES_REGBOT_CONTACT_USE_IP;

    this.fromUser = opts.from_user || this.username;
    const fromDomain = opts.from_domain || this.sip_realm;
    this.from = `sip:${this.fromUser}@${fromDomain}`;
    this.aor = `${this.fromUser}@${this.sip_realm}`;
    this.status = 'none';
  }

  start(srf) {
    this.logger.info(`starting regbot ${this.fromUser}@${this.sip_realm}`);
    assert(!this.timer);
    this.register(srf);
  }

  stop() {
    this.logger.info(`stopping regbot ${this.fromUser}@${this.sip_realm}`);
    clearTimeout(this.timer);
  }

  toJSON() {
    return {
      voip_carrier_sid: this.voip_carrier_sid,
      username: this.username,
      fromUser: this.fromUser,
      sip_realm: this.sip_realm,
      ipv4: this.ipv4,
      port: this.port,
      aor: this.aor,
      status: this.status
    };
  }

  async register(srf) {
    const { updateVoipCarriersRegisterStatus } = srf.locals.dbHelpers;
    try {
      const contactAddress = this.use_public_ip_in_contact ?
        `${this.fromUser}@${srf.locals.sbcPublicIpAddress}` : this.aor;
      this.logger.debug(`sending REGISTER for ${this.aor}`);
      const isIPv4 = /[0-9]{1,3}.[0-9]{1,3}.[0-9]{1,3}.[0-9]{1,3}/.test(this.ipv4);
      const transport = this.protocol.includes('/') ? this.protocol.substring(0, this.protocol.indexOf('/')) :
        this.protocol;
      const proxy = `sip:${this.ipv4}${isIPv4 ? `:${this.port}` : ''};transport=${transport}`;
      const req = await srf.request(`sip${transport === 'tls' ? 's' : ''}:${this.aor}`, {
        method: 'REGISTER',
        proxy,
        headers: {
          'From': this.from,
          'Contact': `<sip:${contactAddress}>;expires=${DEFAULT_EXPIRES}`,
          'Expires': DEFAULT_EXPIRES
        },
        auth: {
          username: this.username,
          password: this.password
        }
      });
      req.on('response', (res) => {
        if (res.status !== 200) {
          this.status = 'fail';
          this.logger.info(`${this.aor}: got ${res.status} registering to ${this.ipv4}:${this.port}`);
          this.timer = setTimeout(this.register.bind(this, srf), 30 * 1000);
        }
        else {
          this.status = 'registered';
          let expires = DEFAULT_EXPIRES;
          const contact = res.getParsedHeader('Contact');
          if (contact.length > 0 && contact[0].params && contact[0].params.expires) {
            if (contact[0].params.expires) expires = parseInt(contact[0].params.expires);
          }
          else if (res.has('Expires')) {
            expires = parseInt(res.get('Expires'));
          }
          if (isNaN(expires) || expires < 30) expires = DEFAULT_EXPIRES;
          debug(`setting timer for next register to ${expires} seconds`);
          this.timer = setTimeout(this.register.bind(this, srf), (expires - 5) * 1000);
        }
        updateVoipCarriersRegisterStatus(this.voip_carrier_sid, JSON.stringify({
          status: res.status === 200 ? 'ok' : 'fail',
          reason: `${res.status} ${res.reason}`,
          cseq: req.get('Cseq'),
          callId: req.get('Call-Id')
        }));
      });
    } catch (err) {
      this.logger.error({ err }, `${this.aor}: Error registering to ${this.ipv4}:${this.port}`);
      this.timer = setTimeout(this.register.bind(this, srf), 60 * 1000);
      updateVoipCarriersRegisterStatus(this.voip_carrier_sid, JSON.stringify({
        status: 'fail',
        reason: err
      }));
    }

  }
}

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
    this.uri = `sip${gateway.protocol.includes('tls') ? 's' : ''}:
${gateway.ipv4}${gateway.port && !gateway.protocol.includes('tls') ? `:${gateway.port}` : ''}`;
  }

  start(srf) {
    this.logger.info(`starting options bot ${this.uri}`);
    assert(!this.timer);
    this.options(srf);
  }

  stop() {
    this.logger.info(`stopping options bot ${this.uri}`);
    clearTimeout(this.timer);
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
        } else {
          this.timer = setTimeout(this.options.bind(this, srf), (process.env.SEND_OPTIONS_PING_INTERVAL || 60) * 1000);
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
  if (initialized) return;
  initialized = true;
  const { addKeyNx } = srf.locals.realtimeDbHelpers;
  const myToken = short.generate();
  srf.locals.regbot = {
    myToken,
    active: false
  };

  /* sleep a random duration between 0 and MAX_INITIAL_DELAY seconds */
  const ms = Math.floor(Math.random() * MAX_INITIAL_DELAY) * 1000;
  logger.info(`waiting ${ms}ms before attempting to claim regbot responsibility with token ${myToken}`);
  await waitFor(ms);

  /* try to claim responsibility */
  const result = await addKeyNx(regbotKey, myToken, REGBOT_STATUS_CHECK_INTERVAL + 10);
  if (result === 'OK') {
    srf.locals.regbot.active = true;
    logger.info(`successfully claimed regbot responsibility with token ${myToken}`);
  }
  else {
    logger.info(`failed to claim regbot responsibility with my token ${myToken}`);
  }

  /* check every so often if I need to go from inactive->active (or vice versa) */
  setInterval(checkStatus.bind(null, logger, srf), REGBOT_STATUS_CHECK_INTERVAL * 1000);

  /* if I am the regbot holder, then kick it off */
  if (srf.locals.regbot.active) {
    updateCarrierRegbots(logger, srf)
      .catch((err) => {
        logger.error({ err }, 'updateCarrierRegbots failure');
      });
  }

  return srf.locals.regbot.active;
};

const checkStatus = async(logger, srf) => {
  const { addKeyNx, addKey, retrieveKey } = srf.locals.realtimeDbHelpers;
  const { myToken, active } = srf.locals.regbot;

  logger.info({ active, myToken }, 'checking in on regbot status');
  try {
    const token = await retrieveKey(regbotKey);
    let grabForTheWheel = false;

    if (active) {
      if (token === myToken) {
        logger.info('I am active, and shall continue in my role as regbot');
        addKey(regbotKey, myToken, REGBOT_STATUS_CHECK_INTERVAL + 10)
          .then(updateCarrierRegbots.bind(null, logger, srf))
          .then(updateSipGatewayOptsBot.bind(null, logger, srf))
          .catch((err) => {
            logger.error({ err }, 'updateCarrierRegbots failure');
          });
      }
      else if (token && token !== myToken) {
        logger.info('Someone else grabbed the role!  I need to stand down');
        regbots.forEach((rb) => rb.stop());
        regbots.length = 0;
        send_options_bots.forEach((b) => b.stop());
        send_options_bots.length = 0;
      }
      else {
        grabForTheWheel = true;
        regbots.forEach((rb) => rb.stop());
        regbots.length = 0;
        send_options_bots.forEach((b) => b.stop());
        send_options_bots.length = 0;
      }
    }
    else {
      if (token) {
        logger.info('I am inactive and someone else is performing the role');
      }
      else {
        grabForTheWheel = true;
      }
    }

    if (grabForTheWheel) {
      logger.info('regbot status is vacated, try to grab it!');
      const result = await addKeyNx(regbotKey, myToken, REGBOT_STATUS_CHECK_INTERVAL + 10);
      if (result === 'OK') {
        srf.locals.regbot.active = true;
        logger.info(`successfully claimed regbot responsibility with token ${myToken}`);
        updateCarrierRegbots(logger, srf)
          .catch((err) => {
            logger.error({ err }, 'updateCarrierRegbots failure');
          });
        updateSipGatewayOptsBot(logger, srf)
          .catch((err) => {
            logger.error({ err }, 'updateSipGatewayOptsBot failure');
          });
      }
      else {
        srf.locals.regbot.active = false;
        logger.info('failed to claim regbot responsibility');
      }
    }
  } catch (err) {
    logger.error({ err }, 'checkStatus: ERROR');
  }
};

const updateSipGatewayOptsBot = async(logger, srf) => {
  try {
    /* first check: has anything changed (new carriers or gateways)? */
    let hasChanged = false;

    const { lookupSipGatewaysByFilters } = srf.locals.dbHelpers;
    const gws = await lookupSipGatewaysByFilters({send_options_ping: true, outbound: true, is_active: true});

    if (JSON.stringify(gws) !== JSON.stringify(send_options_gateways)) hasChanged = true;
    if (hasChanged) {
      debug('updateSipGatewayOptsBot: got new or changed gateways');
      logger.info('updateSipGatewayOptsBot: got new or changed carriers');
      send_options_gateways.length = 0;
      send_options_gateways.push(...gws);
      for (const g of send_options_gateways) {
        const optsBot = new OptionsBot(logger, g);
        send_options_bots.push(optsBot);
        optsBot.start(srf);
      }
      logger.debug(`updateSipGatewayOptsBot: we have started ${regbots.send_options_bots} optionsBots`);
    }
  } catch (err) {
    logger.error({ err }, 'updateSipGatewayOptsBot Error');
  }
};

const updateCarrierRegbots = async(logger, srf) => {
  // Check if We are
  const { lookupAllVoipCarriers, lookupSipGatewaysByCarrier } = srf.locals.dbHelpers;
  try {

    /* first check: has anything changed (new carriers or gateways)? */
    let hasChanged = false;
    const gws = [];
    const cs = (await lookupAllVoipCarriers())
      .filter((c) => c.requires_register && c.is_active)
      .map((c) => pickRelevantCarrierProperties(c));
    if (JSON.stringify(cs) !== JSON.stringify(carriers)) hasChanged = true;
    for (const c of cs) {
      try {
        const arr = (await lookupSipGatewaysByCarrier(c.voip_carrier_sid))
          .filter((gw) => gw.outbound && gw.is_active)
          .map((gw) => {
            gw.carrier = pickRelevantCarrierProperties(c);
            return gw;
          });
        gws.push(...arr);
      } catch (err) {
        logger.error({ err }, 'updateCarrierRegbots Error retrieving gateways');
      }
    }
    if (JSON.stringify(gws) !== JSON.stringify(gateways)) hasChanged = true;

    if (hasChanged) {
      debug('updateCarrierRegbots: got new or changed carriers');
      logger.info('updateCarrierRegbots: got new or changed carriers');
      carriers.length = 0;
      Array.prototype.push.apply(carriers, cs);

      gateways.length = 0;
      Array.prototype.push.apply(gateways, gws);

      // stop / kill existing regbots
      regbots.forEach((rb) => rb.stop());
      regbots.length = 0;

      // start new regbots
      for (const gw of gateways) {
        const rb = new Regbot(logger, {
          voip_carrier_sid: gw.carrier.voip_carrier_sid,
          ipv4: gw.ipv4,
          port: gw.port,
          protocol: gw.protocol,
          username: gw.carrier.register_username,
          password: gw.carrier.register_password,
          sip_realm: gw.carrier.register_sip_realm,
          from_user: gw.carrier.register_from_user,
          from_domain: gw.carrier.register_from_domain,
          use_public_ip_in_contact: gw.carrier.register_public_ip_in_contact
        });
        regbots.push(rb);
        rb.start(srf);
      }
      logger.debug(`updateCarrierRegbots: we have started ${regbots.length} regbots`);
    }
  } catch (err) {
    logger.error({ err }, 'updateCarrierRegbots Error');
  }
};
