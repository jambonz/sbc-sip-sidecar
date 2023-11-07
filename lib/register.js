const {isUacBehindNat, getSipProtocol, NAT_EXPIRES} = require('./utils');
const parseUri = require('drachtio-srf').parseUri;

module.exports = handler;

function handler({logger}) {
  return async(req, res) => {
    logger.debug(`received ${req.method} from ${req.protocol}/${req.source_address}:${req.source_port}`);

    if ('register' === req.registration.type && '0' !== req.registration.expires) await register(logger, req, res);
    else await unregister(logger, req, res);

    req.srf.endSession(req);
  };
}

async function register(logger, req, res) {
  try {
    const registrar = req.srf.locals.registrar;
    const registration = req.registration;
    const uri = parseUri(registration.aor);
    const aor = `${uri.user}@${uri.host}`;
    let expires = req.authorization.grant.expires || registration.expires;
    const grantedExpires = expires;
    let contactHdr = req.get('Contact');

    // reduce the registration interval if the device is behind a nat
    if (isUacBehindNat(req) && expires > NAT_EXPIRES) {
      expires = NAT_EXPIRES;
    }
    contactHdr = contactHdr.replace(/expires=\d+/, `expires=${expires}`);
    const {lookupClientByAccountAndUsername} = req.srf.locals.dbHelpers;
    const {account_sid} = req.locals;
    const client = await lookupClientByAccountAndUsername(account_sid, uri.user);
    const opts = {
      contact: req.getParsedHeader('Contact')[0].uri,
      sbcAddress: req.server.hostport,
      protocol: getSipProtocol(req),
      proxy: `sip:${req.source_address}:${req.source_port}`,
      callHook: req.authorization.grant.call_hook,
      callStatusHook: req.authorization.grant.call_status_hook,
      ...(client && ({
        allow_direct_app_calling: client.allow_direct_app_calling,
        allow_direct_queue_calling: client.allow_direct_queue_calling,
        allow_direct_user_calling: client.allow_direct_user_calling
      }))
    };
    logger.debug(`adding aor to redis ${aor} with expires ${grantedExpires}`);
    await registrar.add(aor, opts, grantedExpires);

    res.send(200, {
      headers: {
        'Contact': contactHdr,
        'Expires': expires
      }
    });
  } catch (err) {
    logger.error({err}, 'Error trying to process REGISTER');
    if (!res.finalResponseSent) res.send(500);
  }
}

async function unregister(logger, req, res) {
  const registrar = req.srf.locals.registrar;
  const uri = parseUri(req.registration.aor);
  const aor = `${uri.user}@${uri.host}`;
  const result = await registrar.remove(aor);

  logger.debug({result}, `successfully unregistered ${req.registration.aor}`);

  res.send(200, {
    headers: {
      'Contact': req.get('Contact'),
      'Expires': 0
    }
  });
}
