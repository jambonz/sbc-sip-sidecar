const parseUri = require('drachtio-srf').parseUri;
const debug = require('debug')('jambonz:sbc-registrar');
const {NAT_EXPIRES} = require('./utils');
const { JAMBONES_HOSTING } = require('./config');

const initLocals = (req, res, next) => {
  req.locals = req.locals || {};
  req.locals.logger = req.srf.locals.logger;
  next();
};

const rejectIpv4 = (req, res, next) => {
  const {logger} = req.locals;
  const uri = parseUri(req.uri);
  if (!uri?.host || /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(uri.host)) {
    logger.info(`rejecting REGISTER from ${req.uri} as it has an ipv4 address and sip realm is required`);
    res.send(403);
    return req.srf.endSession(req);
  }
  next();
};

const checkCache = async(req, res, next) => {
  const {logger} = req.locals;
  const registration = req.registration;
  const uri = parseUri(registration.aor);
  // if cannot parse uri, then we cannot proceed
  if (!uri) {
    return res.send(403, {headers: {
      'X-Reason': 'Invalid address of record'
    }});
  }
  const aor = `${uri.user}@${uri.host}`;
  req.locals.realm = uri.host;

  if (registration.type === 'unregister') return next();

  const registrar = req.srf.locals.registrar;
  const result = await registrar.query(aor);
  if (result) {
    // if known valid registration coming from same address, no need to hit the reg callback hook
    if (result.proxy === `sip:${req.source_address}:${req.source_port}`) {

      // though...check if the expiry is closer than NAT_EXPIRES, if so we do need to auth
      if (Date.now() + (NAT_EXPIRES * 1000) < result.expiryTime) {
        const ex = new Date(result.expiryTime).toISOString();
        const check = new Date(Date.now() + (NAT_EXPIRES * 1000)).toISOString();
        logger.debug({ex, check}, `responding to cached register for ${aor}`);
        res.cached = true;
        res.send(200, {
          headers: {
            'Contact': req.get('Contact').replace(/expires=\d+/, `expires=${NAT_EXPIRES}`),
            'Expires': NAT_EXPIRES
          }
        });
        return req.srf.endSession(req);
      }
      else {
        logger.debug(`cached registration for ${aor} is about to expire, need to re-authenticate`);
      }
    }
  }
  next();
};

const checkAccountLimits = async(req, res, next) => {
  const {logger} = req.locals;
  const {lookupAccountBySipRealm, lookupAccountCapacitiesBySid} = req.srf.locals.dbHelpers;
  const {realm} = req.locals;
  const {registrar, writeAlerts, AlertType} = req.srf.locals;
  try {
    const account = await lookupAccountBySipRealm(realm);
    if (account && !account.is_active) {
      logger.debug('checkAccountLimits: account is deactivated, reject registration');
      return res.send(403, {headers: {
        'X-Reason': 'Account has been deactivated'
      }});
    }
    if (account) {
      req.locals = {
        ...req.locals,
        account_sid: account.account_sid,
        webhook_secret: account.webhook_secret,
        ...(account.registration_hook && {
          registration_hook_url: account.registration_hook.url,
          registration_hook_method: account.registration_hook.method,
          registration_hook_username: account.registration_hook.username,
          registration_hook_password: account.registration_hook.password
        })
      };
      debug(account, `checkAccountLimits: retrieved account for realm: ${realm}`);
    }
    else if (JAMBONES_HOSTING) {
      logger.debug(`checkAccountLimits: unknown sip realm ${realm}`);
      logger.info(`checkAccountLimits: rejecting register for unknown sip realm: ${realm}`);
      return res.send(403);
    }

    if ('unregister' === req.registration.type || !JAMBONES_HOSTING) return next();

    /* only check limits on the jambonz hosted platform */
    const {account_sid} = account;
    const capacities = await lookupAccountCapacitiesBySid(account_sid);
    const limit_calls = capacities.find((c) => c.category == 'voice_call_session');
    let limit_registrations = limit_calls.quantity * account.device_to_call_ratio;
    const extra = capacities.find((c) => c.category == 'device');
    if (extra && extra.quantity) limit_registrations += extra.quantity;
    debug(`call capacity: ${limit_calls.quantity}, device capacity: ${limit_registrations}`);

    if (0 === limit_registrations) {
      logger.info({account_sid}, 'checkAccountLimits: device calling not allowed for this account');
      writeAlerts({
        alert_type: AlertType.ACCOUNT_DEVICE_LIMIT,
        account_sid,
        count: 0
      }).catch((err) => logger.info({err}, 'checkAccountLimits: error writing alert'));

      return res.send(503, 'Max Devices Registered');
    }

    const deviceCount = await registrar.getCountOfUsers(realm);
    if (deviceCount > limit_registrations + 1) {
      logger.info({account_sid}, 'checkAccountLimits: registration rejected due to limits');
      writeAlerts({
        alert_type: AlertType.ACCOUNT_DEVICE_LIMIT,
        account_sid,
        count: limit_registrations
      }).catch((err) => logger.info({err}, 'checkAccountLimits: error writing alert'));
      return res.send(503, 'Max Devices Registered');
    }
    logger.debug(`checkAccountLimits - passed: devices registered ${deviceCount}, limit is ${limit_registrations}`);
    next();
  } catch (err) {
    logger.error({err, realm}, 'checkAccountLimits: error checking account limits');
    res.send(500);
  }
};

module.exports = {
  initLocals,
  rejectIpv4,
  checkCache,
  checkAccountLimits
};
