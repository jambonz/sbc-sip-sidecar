const debug = require('debug')('jambonz:sbc-options-handler');
const { isDrained } = require('./cli/feature-server-config');
const serverControl = require('./server-control');
const {
  EXPIRES_INTERVAL,
  CHECK_EXPIRES_INTERVAL,
  JAMBONES_CLUSTER_ID,
} = require('./config');
const fsServers = new Map();
const fsServiceUrls = new Map();
const rtpServers = new Map();

module.exports = ({srf, logger}) => {
  const {stats, addToSet, removeFromSet, isMemberOfSet, retrieveSet, matcher} = srf.locals;
  const {client} = srf.locals.realtimeDbHelpers;

  const setNameFs = `${(JAMBONES_CLUSTER_ID || 'default')}:active-fs`;
  const setNameRtp = `${(JAMBONES_CLUSTER_ID || 'default')}:active-rtp`;
  const setNameFsSeriveUrl = `${(JAMBONES_CLUSTER_ID || 'default')}:fs-service-url`;

  /* The active-fs / fs-service-url / active-rtp sets are shared by every SBC in the cluster,
     so the decision to expire a member must be based on the last time ANY SBC heard from it,
     not just this one.  Each SBC records the last ping it received per member in a shared
     redis hash (`<setName>:lastseen`, member -> epoch ms); the sweep below removes a member
     only when that shared timestamp is stale.  A member with no shared timestamp is never
     expired by the sweep - e.g. an SBC that has been taken out of active-sip and is no longer
     being pinged must not remove members the other SBCs are still hearing from. */
  const lastSeenHash = (setName) => `${setName}:lastseen`;

  const _expireStaleMembers = async(map, setName, now, expires) => {
    const lastSeen = await client.hgetall(lastSeenHash(setName));
    for (const [key, ts] of Object.entries(lastSeen)) {
      if (now - Number(ts) > expires) {
        map.delete(key);
        await client.hdel(lastSeenHash(setName), key);
        await removeFromSet(setName, key);
        const members = await retrieveSet(setName);
        const countOfMembers = members.length;
        logger.info({members}, `expired member ${key} from ${setName} we now have ${countOfMembers}`);
      }
    }
  };

  /* check for expired servers every so often */
  const expiryTimer = setInterval(async() => {
    const now = Date.now();
    const expires = EXPIRES_INTERVAL || 60000;
    try {
      await _expireStaleMembers(fsServers, setNameFs, now, expires);
      await _expireStaleMembers(fsServiceUrls, setNameFsSeriveUrl, now, expires);
      await _expireStaleMembers(rtpServers, setNameRtp, now, expires);
    } catch (err) {
      logger.error({err}, 'error expiring stale members');
    }
  }, CHECK_EXPIRES_INTERVAL || 20000);
  expiryTimer.unref();

  /* retrieve the initial list of servers, if any, so we can watch them as well */
  const _init = async() => {
    try {
      const now = Date.now();
      const runningFs = await retrieveSet(setNameFs);
      const runningRtp = await retrieveSet(setNameRtp);
      const runningFsServiceUrls = await retrieveSet(setNameFsSeriveUrl);

      if (runningFs.length) {
        logger.info({runningFs}, 'start watching these FS servers');
        for (const ip of runningFs) fsServers.set(ip, now);
      }

      if (runningFsServiceUrls.length) {
        logger.info({runningFsServiceUrls}, 'start watching these FS Service Urls');
        for (const url of runningFsServiceUrls) fsServiceUrls.set(url, now);
      }

      if (runningRtp.length) {
        logger.info({runningRtp}, 'start watching these RTP servers');
        for (const ip of runningRtp) rtpServers.set(ip, now);
      }
    } catch (err) {
      logger.error({err}, 'error initializing from redis');
    }
  };
  _init();

  const _addToCache = async(map, status, setName, key) => {
    let countOfMembers;
    if (status === 'open') {
      const now = Date.now();
      map.set(key, now);
      await client.hset(lastSeenHash(setName), key, now);
      const exists = await isMemberOfSet(setName, key);
      if (!exists) {
        await addToSet(setName, key);
        const members = await retrieveSet(setName);
        countOfMembers = members.length;
        logger.info({members}, `added new member ${key} to ${setName} we now have ${countOfMembers}`);
        debug({members}, `added new member ${key} to ${setName}`);
      }
      else {
        const members = await retrieveSet(setName);
        countOfMembers = members.length;
        debug(`checkin from existing member ${key} to ${setName}`);
      }
    }
    else {
      map.delete(key);
      await client.hdel(lastSeenHash(setName), key);
      await removeFromSet(setName, key);
      const members = await retrieveSet(setName);
      countOfMembers = members.length;
      logger.info({members}, `removed member ${key} from ${setName} we now have ${countOfMembers}`);
      debug({members}, `removed member ${key} from ${setName}`);
    }
    return countOfMembers;
  };

  return async(req, res) => {

    /* server-control: topology discovery request (X-Jambonz-Discover: true).
       Deliberately answerable from any (external) IP - it is gated only by the
       JAMBONES_SERVER_CONTROL env var and the presence of the discovery header. */
    if (serverControl.isEnabled() && serverControl.isDiscoverRequest(req)) {
      try {
        const topology = await serverControl.discoverServers(req.srf);
        logger.info({source_address: req.source_address, topology},
          'responding to X-Jambonz-Discover OPTIONS request');
        res.send(200, {
          body: JSON.stringify(topology),
          headers: {
            'Content-Type': 'application/json'
          }
        });
      } catch (err) {
        logger.error({err}, 'Error handling discovery OPTIONS');
        res.send(503);
      }
      return req.srf.endSession(req);
    }

    /* OPTIONS ping from internal FS or RTP server? */
    const internal = req.has('X-FS-Status') || req.has('X-RTP-Status');
    if (!internal) {
      debug('got external OPTIONS ping');
      res.send(200);
      return req.srf.endSession(req);
    }

    /* an internal status ping must originate from within our private network;
       otherwise an attacker could insert bogus active-fs / active-rtp records into redis.
       Silently ignore (respond as an ordinary OPTIONS ping) if the source is not trusted. */
    if (matcher && !matcher.contains(req.source_address)) {
      logger.warn({source_address: req.source_address},
        'ignoring FS/RTP status OPTIONS ping from IP outside JAMBONES_NETWORK_CIDR');
      res.send(200);
      return req.srf.endSession(req);
    }

    try {
      let map, status, countOfMembers;
      const h = ['X-FS-Status', 'X-RTP-Status'].find((h) => req.has(h));
      if (h) {
        const isRtpServer = req.has('X-RTP-Status');
        const key       = isRtpServer ? req.source_address : `${req.source_address}:${req.source_port}`;
        const prefix    = isRtpServer ? 'X-RTP' : 'X-FS';
        map             = isRtpServer ? rtpServers : fsServers;
        const setName   = isRtpServer ? setNameRtp : setNameFs;
        const gaugeName = isRtpServer ? 'rtpservers' : 'featureservers';
        const fsServiceUrlKey = req.has('X-FS-ServiceUrl') ? req.get('X-FS-ServiceUrl') : null;

        status = req.get(`${prefix}-Status`);

        // If feature server is drained, force status to closed
        if (status === 'open' && !isRtpServer) {
          const fsIP = req.source_address;
          if (await isDrained(fsIP)) {
            logger.warn({fsIP}, 'drained feature server attempted to check in - rejecting');
            status = 'closed';
          }
        }

        countOfMembers = await _addToCache(map, status, setName, key);
        if (fsServiceUrlKey) {
          await _addToCache(fsServiceUrls, status, setNameFsSeriveUrl, fsServiceUrlKey);
        }
        stats.gauge(gaugeName, map.size);
      }
      res.send(200, {headers: {
        'X-Members': countOfMembers
      }});
    } catch (err) {
      res.send(503);
      debug(err);
      logger.error({err}, 'Error handling OPTIONS');
    }
    return req.srf.endSession(req);
  };
};
