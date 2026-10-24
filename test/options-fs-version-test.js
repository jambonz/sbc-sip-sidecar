const test = require('tape');
const clearModule = require('clear-module');

/* Unit test: a feature server's X-FS-Version on its status ping is stored per member and
   reported by topology discovery as featureServerVersions; it goes away when the member
   closes, and junk values are not stored. */

test('options: feature server versions are stored and reported by discovery', async(t) => {
  clearModule.all();
  process.env.JAMBONES_SERVER_CONTROL = '1';

  const logger = require('pino')({level: 'silent'});
  const rdb = require('@jambonz/realtimedb-helpers')({}, logger);
  const {client, addToSet, removeFromSet, isMemberOfSet, retrieveSet} = rdb;
  const stats = {gauge: () => {}};
  const srf = {
    locals: {stats, addToSet, removeFromSet, isMemberOfSet, retrieveSet, realtimeDbHelpers: {client}},
    endSession: () => {}
  };

  const setName = 'default:active-fs';
  const keys = [setName, `${setName}:lastseen`, `${setName}:version`];
  const cleanup = () => client.del(...keys);

  /* a minimal drachtio request/response pair for an internal FS status ping */
  const ping = (ip, headers) => new Promise((resolve) => {
    const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    const req = {
      srf, source_address: ip, source_port: 5060,
      has: (n) => n.toLowerCase() in h,
      get: (n) => h[n.toLowerCase()]
    };
    handler(req, {send: (status) => resolve(status)});
  });

  let handler;
  try {
    await cleanup();
    handler = require('../lib/options')({srf, logger});
    const {discoverServers} = require('../lib/server-control');

    t.equal(await ping('10.0.0.1', {'X-FS-Status': 'open', 'X-FS-Version': '11.1.9'}), 200, 'ping accepted');
    await ping('10.0.0.2', {'X-FS-Status': 'open'});                            // older feature server
    await ping('10.0.0.3', {'X-FS-Status': 'open', 'X-FS-Version': '<script>'}); // junk

    let topo = await discoverServers(srf);
    t.deepEqual(topo.featureServers.sort(), ['10.0.0.1:5060', '10.0.0.2:5060', '10.0.0.3:5060'], 'all three are members');
    t.deepEqual(topo.featureServerVersions, {'10.0.0.1:5060': '11.1.9'},
      'only the server that reported a valid version has one');

    /* an upgrade is picked up on the next ping */
    await ping('10.0.0.1', {'X-FS-Status': 'open', 'X-FS-Version': '11.1.10'});
    topo = await discoverServers(srf);
    t.equal(topo.featureServerVersions['10.0.0.1:5060'], '11.1.10', 'new version replaces the old');

    /* closing removes the member and its version */
    await ping('10.0.0.1', {'X-FS-Status': 'closed', 'X-FS-Version': '11.1.10'});
    topo = await discoverServers(srf);
    t.deepEqual(topo.featureServerVersions, {}, 'version removed with the member');
    t.equal(await client.hexists(`${setName}:version`, '10.0.0.1:5060'), 0, 'version hash entry deleted');

    await cleanup();
    client.quit();
    t.end();
  } catch (err) {
    await cleanup();
    client.quit();
    t.end(err);
  } finally {
    delete process.env.JAMBONES_SERVER_CONTROL;
  }
});
