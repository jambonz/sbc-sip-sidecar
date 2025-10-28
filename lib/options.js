const debug = require('debug')('jambonz:sbc-options-handler');
const { isDrained } = require('./cli/feature-server-config');
const {
  EXPIRES_INTERVAL,
  CHECK_EXPIRES_INTERVAL,
  JAMBONES_CLUSTER_ID,
} = require('./config');
const fsServers = new Map();
const fsServiceUrls = new Map();
const rtpServers = new Map();

module.exports = ({srf, logger}) => {
  const {stats, addToSet, removeFromSet, isMemberOfSet, retrieveSet} = srf.locals;

  const setNameFs = `${(JAMBONES_CLUSTER_ID || 'default')}:active-fs`;
  const setNameRtp = `${(JAMBONES_CLUSTER_ID || 'default')}:active-rtp`;
  const setNameFsSeriveUrl = `${(JAMBONES_CLUSTER_ID || 'default')}:fs-service-url`;

  /* check for expired servers every so often */
  setInterval(async() => {
    const now = Date.now();
    const expires = EXPIRES_INTERVAL || 60000;
    for (const [key, value] of fsServers) {
      const duration = now - value;
      if (duration > expires) {
        fsServers.delete(key);
        await removeFromSet(setNameFs, key);
        const members = await retrieveSet(setNameFs);
        const countOfMembers = members.length;
        logger.info({members}, `expired member ${key} from ${setNameFs} we now have ${countOfMembers}`);
      }
    }
    for (const [key, value] of fsServiceUrls) {
      const duration = now - value;
      if (duration > expires) {
        fsServiceUrls.delete(key);
        await removeFromSet(setNameFsSeriveUrl, key);
        const members = await retrieveSet(setNameFsSeriveUrl);
        const countOfMembers = members.length;
        logger.info({members}, `expired member ${key} from ${setNameFsSeriveUrl} we now have ${countOfMembers}`);
      }
    }
    for (const [key, value] of rtpServers) {
      const duration = now - value;
      if (duration > expires) {
        rtpServers.delete(key);
        await removeFromSet(setNameRtp, key);
        const members = await retrieveSet(setNameRtp);
        const countOfMembers = members.length;
        logger.info({members}, `expired member ${key} from ${setNameRtp} we now have ${countOfMembers}`);
      }
    }
  }, CHECK_EXPIRES_INTERVAL || 20000);

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
      map.set(key, Date.now());
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
      await removeFromSet(setName, key);
      const members = await retrieveSet(setName);
      countOfMembers = members.length;
      logger.info({members}, `removed member ${key} from ${setName} we now have ${countOfMembers}`);
      debug({members}, `removed member ${key} from ${setName}`);
    }
    return countOfMembers;
  };

  return async(req, res) => {

    /* OPTIONS ping from internal FS or RTP server? */
    const internal = req.has('X-FS-Status') || req.has('X-RTP-Status');
    if (!internal) {
      debug('got external OPTIONS ping');
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
