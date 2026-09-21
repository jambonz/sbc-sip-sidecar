const test = require('tape');
const clearModule = require('clear-module');

/* Unit test for the expiry sweep in lib/options.js.
   The active-fs / fs-service-url / active-rtp sets are shared by every SBC in the cluster,
   so a member must only be expired when the SHARED last-seen timestamp is stale, never
   because this particular SBC has stopped receiving pings. */

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('options: expiry sweep uses shared last-seen, not local view', async(t) => {
  clearModule.all();
  process.env.EXPIRES_INTERVAL = '1000';
  process.env.CHECK_EXPIRES_INTERVAL = '300';

  const logger = require('pino')({level: 'silent'});
  const rdb = require('@jambonz/realtimedb-helpers')({}, logger);
  const {client, addToSet, removeFromSet, isMemberOfSet, retrieveSet} = rdb;
  const stats = {gauge: () => {}};
  const srf = {locals: {stats, addToSet, removeFromSet, isMemberOfSet, retrieveSet, realtimeDbHelpers: {client}}};

  const setName = 'default:active-fs';
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
    clearModule.all();
  }
});
