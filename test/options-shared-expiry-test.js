const test = require('tape');
const clearModule = require('clear-module');

/* Unit test for the expiry sweep in lib/options.js.
   The active-fs / fs-service-url / active-rtp sets are shared by every SBC in the cluster,
   so a member must only be expired when the SHARED last-seen timestamp is stale, never
   because this particular SBC has stopped receiving pings. */

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('options: expiry sweep uses shared last-seen, not local view', async(t) => {
  clearModule.all();
  /* own cluster id: this handler's sweep timer outlives the test (see the drain test below) */
  process.env.JAMBONES_CLUSTER_ID = 'shared-expiry-test';
  process.env.EXPIRES_INTERVAL = '1000';
  process.env.CHECK_EXPIRES_INTERVAL = '300';

  const logger = require('pino')({level: 'silent'});
  const rdb = require('@jambonz/realtimedb-helpers')({}, logger);
  const {client, addToSet, removeFromSet, isMemberOfSet, retrieveSet} = rdb;
  const stats = {gauge: () => {}};
  const srf = {locals: {stats, addToSet, removeFromSet, isMemberOfSet, retrieveSet, realtimeDbHelpers: {client}}};

  const setName = 'shared-expiry-test:active-fs';
  const lastSeen = `${setName}:lastseen`;
  const fresh = '10.0.0.1:5060';    // pinged another SBC recently
  const stale = '10.0.0.2:5060';    // nobody has heard from it
  const legacy = '10.0.0.3:5060';   // in the set with no shared timestamp

  const cleanup = async() => {
    await client.del(setName, lastSeen);
  };

  try {
    await cleanup();
    await client.sadd(setName, fresh, stale, legacy);
    await client.hset(lastSeen, stale, Date.now() - 5000);

    /* start the options handler: this SBC has never been pinged by any of these members */
    require('../lib/options')({srf, logger});

    /* simulate another SBC continuing to hear from `fresh` */
    const refresher = setInterval(() => client.hset(lastSeen, fresh, Date.now()), 200);

    await wait(1500);
    clearInterval(refresher);

    const members = (await retrieveSet(setName)).sort();
    t.ok(members.includes(fresh), 'member still being pinged by another SBC is kept');
    t.notOk(members.includes(stale), 'member nobody has heard from within EXPIRES_INTERVAL is expired');
    t.ok(members.includes(legacy), 'member with no shared last-seen is left alone');
    t.equal(await client.hexists(lastSeen, stale), 0, 'expired member removed from shared last-seen hash');

    await cleanup();
    client.quit();
    t.end();
  } catch (err) {
    await cleanup();
    client.quit();
    t.end(err);
  } finally {
    delete process.env.EXPIRES_INTERVAL;
    delete process.env.CHECK_EXPIRES_INTERVAL;
    delete process.env.JAMBONES_CLUSTER_ID;
    clearModule.all();
  }
});

/* A drain is keyed by bare IP.  Once the drained instance stops pinging, the drain must be
   removed so that a new instance later assigned the same private IP is not kept out of rotation. */
test('options: drains are removed once the drained server stops pinging', async(t) => {
  clearModule.all();
  /* own cluster id: this handler's sweep timer outlives the test, and must not expire the
     drains that cli-tests sets up later in the same process */
  process.env.JAMBONES_CLUSTER_ID = 'drain-expiry-test';
  process.env.EXPIRES_INTERVAL = '1000';
  process.env.CHECK_EXPIRES_INTERVAL = '300';

  const logger = require('pino')({level: 'silent'});
  const rdb = require('@jambonz/realtimedb-helpers')({}, logger);
  const {client, addToSet, removeFromSet, isMemberOfSet, retrieveSet} = rdb;
  const stats = {gauge: () => {}};
  const srf = {locals: {stats, addToSet, removeFromSet, isMemberOfSet, retrieveSet, realtimeDbHelpers: {client}}};

  const setName = 'drain-expiry-test:drained-fs';
  const lastSeen = `${setName}:lastseen`;
  const alive = '10.0.1.1';      // drained and still pinging
  const departed = '10.0.1.2';   // drained, instance gone long ago
  const fresh = '10.0.1.3';      // just drained via cli, no timestamp yet, never pings
  const undrained = '10.0.1.4';  // timestamp left over after an undrain

  const cleanup = async() => {
    await client.del(setName, lastSeen);
  };

  try {
    await cleanup();
    await client.sadd(setName, alive, departed, fresh);
    await client.hset(lastSeen, departed, Date.now() - 5000);
    await client.hset(lastSeen, undrained, Date.now());

    require('../lib/options')({srf, logger});
    const refresher = setInterval(() => client.hset(lastSeen, alive, Date.now()), 200);

    await wait(700);
    let members = await retrieveSet(setName);
    t.notOk(members.includes(departed), 'drain for a server nobody has heard from is removed');
    t.ok(members.includes(fresh), 'newly drained server is kept while its clock starts');
    t.equal(await client.hexists(lastSeen, fresh), 1, 'sweep starts the clock for a newly drained server');
    t.equal(await client.hexists(lastSeen, undrained), 0, 'timestamp for an undrained server is forgotten');

    await wait(1200);
    clearInterval(refresher);
    members = await retrieveSet(setName);
    t.ok(members.includes(alive), 'drain for a server that is still pinging is kept');
    t.notOk(members.includes(fresh), 'drain for a server that never pinged expires after the window');

    await cleanup();
    client.quit();
    t.end();
  } catch (err) {
    await cleanup();
    client.quit();
    t.end(err);
  } finally {
    delete process.env.EXPIRES_INTERVAL;
    delete process.env.CHECK_EXPIRES_INTERVAL;
    delete process.env.JAMBONES_CLUSTER_ID;
    clearModule.all();
  }
});
