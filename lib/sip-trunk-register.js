const debug = require('debug')('jambonz:sbc-registrar');
const assert = require('assert');
const short = require('short-uuid');
const DEFAULT_EXPIRES = (parseInt(process.env.REGISTER_EXPIRES) || 3600);
const MAX_INITIAL_DELAY = 15;
const REGBOT_STATUS_CHECK_INTERVAL = 60;
const regbotKey = `${(process.env.JAMBONES_CLUSTER_ID || 'default')}:regbot-token`;
const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let initialized = false;

const regbots = [];
const carriers = [];
const gateways = [];

class Regbot {
  constructor(logger, opts) {
    this.logger = logger;

    ['ipv4', 'port', 'username', 'password', 'sip_realm'].forEach((prop) => this[prop] = opts[prop]);

    logger.debug({opts}, 'Regbot');
    this.username = opts.username;
    this.password = opts.password;
    this.sip_realm = opts.sip_realm || opts.ipv4;
    this.ipv4 = opts.ipv4;
    this.port = opts.port;
    this.use_public_ip_in_contact = opts.use_public_ip_in_contact || process.env.JAMBONES_REGBOT_CONTACT_USE_IP;

    const fromUser = opts.from_user || this.username;
    const fromDomain = opts.from_domain || this.sip_realm;
    this.from = `sip:${fromUser}@${fromDomain}`;
    this.aor = `${this.username}@${this.sip_realm}`;
    this.status = 'none';
  }

  start(srf) {
    assert(!this.timer);
    this.register(srf);
  }

  stop() {
    clearTimeout(this.timer);
  }

  toJSON() {
    return {
      username: this.username,
      sip_realm: this.sip_realm,
      ipv4: this.ipv4,
      port: this.port,
      aor: this.aor,
      status: this.status
    };
  }

  async register(srf) {
    try {
      const contactAddress = this.use_public_ip_in_contact ?
        `${this.username}@${srf.locals.sbcPublicIpAddress}` : this.aor;
      const req = await srf.request(`sip:${this.aor}`, {
        method: 'REGISTER',
        proxy: `sip:${this.ipv4}:${this.port}`,
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
          this.logger.info(`Regbot: got ${res.status} registering to ${this.sip_realm} at ${this.ipv4}:${this.port}`);
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
      });
    } catch (err) {
      this.logger.error({ err }, `Regbot Error registering to ${this.ipv4}:${this.port}`);
      this.timer = setTimeout(this.register.bind(this, srf), 60 * 1000);
    }
  }
}

module.exports = async(logger, srf) => {
  if (initialized) return;
  initialized = true;
  const {addKeyNx} = srf.locals.realtimeDbHelpers;
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
        logger.error({err}, 'updateCarrierRegbots failure');
      });
  }

  return srf.locals.regbot.active;
};

const checkStatus = async(logger, srf) => {
  const {addKeyNx, addKey, retrieveKey} = srf.locals.realtimeDbHelpers;
  const {myToken, active} = srf.locals.regbot;

  logger.info({active, myToken}, 'checking in on regbot status');
  try {
    const token = await retrieveKey(regbotKey);
    let grabForTheWheel = false;

    if (active) {
      if (token === myToken) {
        logger.info('I am active, and shall continue in my role as regbot');
        addKey(regbotKey, myToken, REGBOT_STATUS_CHECK_INTERVAL + 10)
          .then(updateCarrierRegbots.bind(null, logger, srf))
          .catch((err) => {
            logger.error({err}, 'updateCarrierRegbots failure');
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
            logger.error({err}, 'updateCarrierRegbots failure');
          });
      }
      else {
        srf.locals.regbot.active = false;
        logger.info('failed to claim regbot responsibility');
      }
    }
  } catch (err) {
    logger.error({err}, 'checkStatus: ERROR');
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
      .filter((c) => c.requires_register);
    if (JSON.stringify(cs) !== JSON.stringify(carriers)) hasChanged = true;
    for (const c of cs) {
      try {
        const arr = (await lookupSipGatewaysByCarrier(c.voip_carrier_sid))
          .filter((gw) => gw.outbound && gw.is_active)
          .map((gw) => {
            gw.carrier = c;
            return gw;
          });
        Array.prototype.push.apply(gws, arr);
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
          ipv4: gw.ipv4,
          port: gw.port,
          username: gw.carrier.register_username,
          password: gw.carrier.register_password,
          sip_realm: gw.carrier.register_sip_realm,
          from_user: gw.carrier.register_from_user,
          from_domain: gw.carrier.register_from_domain,
          use_public_ip_in_contact: gw.carrier.register_public_ip_in_contact
        });
        regbots.push(rb);
        rb.start(srf);
        logger.info({ regbot: rb.toJSON() }, 'Starting regbot');
      }
      debug(`updateCarrierRegbots: we have ${regbots.length} regbots`);
    }
  } catch (err) {
    logger.error({ err }, 'updateCarrierRegbots Error');
  }
};
