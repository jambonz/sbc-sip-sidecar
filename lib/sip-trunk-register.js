const debug = require('debug')('jambonz:sbc-registrar');
const {
  JAMBONES_CLUSTER_ID,
  JAMBONES_REGBOT_BATCH_SLEEP_MS,
  JAMBONES_REGBOT_BATCH_SIZE,
} = require('./config');
const short = require('short-uuid');
const Regbot = require('./regbot');
const { sleepFor } = require('./utils');

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
    register_public_ip_in_contact: c.register_public_ip_in_contact,
    outbound_sip_proxy: c.outbound_sip_proxy,
    account_sid: c.account_sid,
  };
}

async function getLocalSIPDomain(logger, srf) {
  const { lookupSystemInformation } = srf.locals.dbHelpers;
  try {
    const systemInfo = await lookupSystemInformation();
    if (systemInfo) {
      logger.info(`lookup of sip domain from system_information: ${systemInfo.sip_domain_name}`);
      srf.locals.localSIPDomain = systemInfo.sip_domain_name;
    }
    else {
      logger.info('no system_information found, we will use the realm or public ip as the domain');
      return false;
    }
  } catch (err) {
    logger.info({ err }, 'Error looking up system information');
    return false;
  }
}

/**
 * Filters gateway array to remove duplicates based on ipv4, sip_realm, username and password
 * @param {Array} gateways - Array of gateway objects
 * @param {Object} logger - Logger instance to log duplicate entries
 * @returns {Array} - Filtered array with unique gateways
 */
function getUniqueGateways(gateways, logger) {
  const uniqueGatewayKeys = new Set();

  return gateways.filter((gw) => {
    const key = `${gw.ipv4}:${gw.sip_realm}:${gw.carrier?.register_username}:${gw.carrier?.register_password}`;
    if (!gw.carrier?.register_password) {
      logger.info({gw}, `Gateway ${key} does not have a password, ignoring`);
      return false;
    }

    // If we've already seen this key, it's a duplicate
    if (uniqueGatewayKeys.has(key)) {
      logger.info({gw}, `Found duplicate gateway ${key}, ignoring`);
      return false;
    }

    // Otherwise, add it to our Set and keep this gateway
    uniqueGatewayKeys.add(key);
    return true;
  });
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

  /* Set the Local SIP domain on srf.locals */
  await getLocalSIPDomain(logger, srf); // Initial Setup
  setInterval(getLocalSIPDomain, 300000, logger, srf); //Refresh SIP Domain every 5 mins

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
  const { lookupAllVoipCarriers, lookupSipGatewaysByCarrier, lookupAccountBySid } = srf.locals.dbHelpers;
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
      let batch_count = 0;
      for (const gw of getUniqueGateways(gateways, logger)) {
        // find gateway account sip realm.
        if (gw.carrier.account_sid) {
          const account = await lookupAccountBySid(gw.carrier.account_sid);
          if (account && account.sip_realm) {
            gw.account_sip_realm = account.sip_realm;
          }
        }
        try {
          const rb = new Regbot(logger, {
            voip_carrier_sid: gw.carrier.voip_carrier_sid,
            account_sip_realm: gw.account_sip_realm,
            ipv4: gw.ipv4,
            port: gw.port,
            protocol: gw.protocol,
            use_sips_scheme: gw.use_sips_scheme,
            username: gw.carrier.register_username,
            password: gw.carrier.register_password,
            sip_realm: gw.carrier.register_sip_realm,
            from_user: gw.carrier.register_from_user,
            from_domain: gw.carrier.register_from_domain,
            use_public_ip_in_contact: gw.carrier.register_public_ip_in_contact,
            outbound_sip_proxy: gw.carrier.outbound_sip_proxy
          });
          regbots.push(rb);
          rb.start(srf);
          batch_count++;
          if (batch_count >= JAMBONES_REGBOT_BATCH_SIZE) {
            batch_count = 0;
            await sleepFor(JAMBONES_REGBOT_BATCH_SLEEP_MS);
          }
        } catch (err) {
          const { updateVoipCarriersRegisterStatus } = srf.locals.dbHelpers;
          updateVoipCarriersRegisterStatus(gw.carrier.voip_carrier_sid, JSON.stringify({
            status:  'fail',
            reason: err.message,
          }));
          logger.error({ err }, `Error starting regbot, ignore register for ${this.fr}`);
        }
      }
      logger.debug(`updateCarrierRegbots: we have started ${regbots.length} regbots`);
    }
  } catch (err) {
    logger.error({ err }, 'updateCarrierRegbots Error');
  }
};
