const debug = require('debug')('jambonz:sbc-registrar');
const {
  JAMBONES_CLUSTER_ID,
  JAMBONES_REGBOT_CONTACT_USE_IP,
  JAMBONES_REGBOT_DEFAULT_EXPIRES_INTERVAL,
  JAMBONES_REGBOT_MIN_EXPIRES_INTERVAL
} = require('./config');
const assert = require('assert');
const short = require('short-uuid');
const {isValidIPv4} = require('./utils');
const DEFAULT_EXPIRES = (parseInt(JAMBONES_REGBOT_DEFAULT_EXPIRES_INTERVAL) || 3600);
const MIN_EXPIRES = (parseInt(JAMBONES_REGBOT_MIN_EXPIRES_INTERVAL) || 30);
const MAX_INITIAL_DELAY = 15;
const REGBOT_STATUS_CHECK_INTERVAL = 60;
const regbotKey = `${(JAMBONES_CLUSTER_ID || 'default')}:regbot-token`;
const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let initialized = false;

const regbots = [];
const carriers = [];
const gateways = [];


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
    this.use_public_ip_in_contact = opts.use_public_ip_in_contact || JAMBONES_REGBOT_CONTACT_USE_IP;
    this.use_sips_scheme = opts.use_sips_scheme || false;

    this.fromUser = opts.from_user || this.username;
    const fromDomain = opts.from_domain || this.sip_realm;
    this.from = `sip:${this.fromUser}@${fromDomain}`;
    this.aor = `${this.fromUser}@${this.sip_realm}`;
    this.status = 'none';
  }

  async start(srf) {
    const { lookupSystemInformation } = srf.locals.dbHelpers;
    assert(!this.timer);

    this.logger.info(`starting regbot for ${this.fromUser}@${this.sip_realm}`);
    try {
      const info = await lookupSystemInformation();
      if (info) {
        this.ourSipDomain = info.sip_domain_name;
        this.logger.info(`lookup of sip domain from system_information: ${this.ourSipDomain}`);
      }
      else {
        this.logger.info('no system_information found, we will use the realm or public ip as the domain');
      }
    } catch (err) {
      this.logger.info({ err }, 'Error looking up system information');
    }
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
      // transport
      const transport = (this.protocol.includes('/') ? this.protocol.substring(0, this.protocol.indexOf('/')) :
        this.protocol).toLowerCase();

      // scheme
      let scheme = 'sip';
      if (transport === 'tls' && this.use_sips_scheme) scheme = 'sips';

      let publicAddress = srf.locals.sbcPublicIpAddress.udp;
      if (transport !== 'udp') {
        if (srf.locals.sbcPublicIpAddress[transport]) {
          publicAddress = srf.locals.sbcPublicIpAddress[transport];
        }
        else if (transport === 'tls') {
          publicAddress = srf.locals.sbcPublicIpAddress.udp;
        }
      }

      let contactAddress = this.aor;
      if (this.use_public_ip_in_contact) {
        contactAddress = `${this.fromUser}@${publicAddress}`;
      }
      else if (this.ourSipDomain) {
        contactAddress = `${this.fromUser}@${this.ourSipDomain}`;
      }

      this.logger.debug(`sending REGISTER for ${this.aor}`);
      const isIPv4 = isValidIPv4(this.ipv4);

      const proxy = `sip:${this.ipv4}${isIPv4 ? `:${this.port}` : ''};transport=${transport}`;
      this.logger.debug({isIPv4}, `sending via proxy ${proxy}`);
      const req = await srf.request(`${scheme}:${this.sip_realm}`, {
        method: 'REGISTER',
        proxy,
        headers: {
          'From': this.from,
          'To': this.from,
          'Contact': `<${scheme}:${contactAddress};transport=${transport}>;expires=${DEFAULT_EXPIRES}`,
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

          // the code parses the SIP headers to get the expires value
          // if there is a Contact header, it will use the expires value from there
          // otherwise, it will use the Expires header, acording to the SIP RFC 3261, section 10.2.4 Refreshing Bindings
          this.status = 'registered';
          let expires = DEFAULT_EXPIRES;

          if (res.has('Expires')) {
            expires = parseInt(res.get('Expires'));
          }

          if (res.has('Contact')) {
            const contact = res.getParsedHeader('Contact');
            if (contact.length > 0 && contact[0].params && contact[0].params.expires) {
              expires = parseInt(contact[0].params.expires);
            }
          } else {
            this.logger.info({ aor: this.aor, ipv4: this.ipv4, port: this.port },
              'no Contact header in 200 OK');
          }

          if (isNaN(expires) || expires < MIN_EXPIRES) {
            this.logger.info({ aor: this.aor, ipv4: this.ipv4, port: this.port },
              `got expires of ${expires} in 200 OK, too small so setting to ${MIN_EXPIRES}`);
            expires = MIN_EXPIRES;
          }
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
          .catch((err) => {
            logger.error({ err }, 'updateCarrierRegbots failure');
          });
      }
      else if (token && token !== myToken) {
        logger.info('Someone else grabbed the role!  I need to stand down');
        regbots.forEach((rb) => rb.stop());
        regbots.length = 0;
      }
      else {
        grabForTheWheel = true;
        regbots.forEach((rb) => rb.stop());
        regbots.length = 0;
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
          use_sips_scheme: gw.use_sips_scheme,
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
