const test = require('tape');
const Regbot = require('../lib/regbot');
const {
  JAMBONES_LOGLEVEL,
} = require('../lib/config');
const opts = Object.assign({
  timestamp: () => { return `, "time": "${new Date().toISOString()}"`; }
}, { level: JAMBONES_LOGLEVEL || 'info' });
const logger = require('pino')(opts);

/**
 * These tests demonstrate the concurrent-rebuild race condition in
 * updateCarrierRegbots (ticket #2719).
 *
 * The bug: updateCarrierRegbots is called via .then() (not awaited) from
 * checkStatus every 60 seconds. With no mutex, multiple concurrent invocations
 * operate on the shared regbots array. If one invocation sees a carrier and
 * another doesn't (because the DB query returned slightly different results),
 * the second invocation's cleanup stop()s/stopTimer()s regbots that the first
 * invocation placed in the array, permanently breaking their timer chain.
 *
 * The fix: a simple boolean mutex (rebuildInProgress). Skipped rebuilds are
 * fine because checkStatus fires again 60s later.
 */

/**
 * Simulated Redis store (same as regbot-race-condition-test.js)
 */
function createRedisStore() {
  const store = {};
  return {
    store,
    createEphemeralGateway(ip, voipCarrierSid, ttlSeconds) {
      if (!store[ip]) store[ip] = {};
      store[ip][voipCarrierSid] = Math.floor(Date.now() / 1000) + ttlSeconds;
      return Promise.resolve(true);
    },
    deleteEphemeralGateway(ip, voipCarrierSid) {
      if (store[ip]) {
        delete store[ip][voipCarrierSid];
        if (Object.keys(store[ip]).length === 0) delete store[ip];
      }
      return Promise.resolve(true);
    },
    hasGateway(ip, voipCarrierSid) {
      return !!(store[ip] && store[ip][voipCarrierSid]);
    },
    gatewayCount() {
      let count = 0;
      for (const ip of Object.keys(store)) {
        count += Object.keys(store[ip]).length;
      }
      return count;
    }
  };
}

function createMockSrf(redisStore) {
  return {
    locals: {
      realtimeDbHelpers: {
        createEphemeralGateway: redisStore.createEphemeralGateway.bind(redisStore),
        deleteEphemeralGateway: redisStore.deleteEphemeralGateway.bind(redisStore),
      },
      dbHelpers: {
        updateVoipCarriersRegisterStatus: () => {},
      },
      sbcPublicIpAddress: { udp: '203.0.113.1' },
      writeAlerts: () => {},
      localSIPDomain: 'sbc.example.com',
    }
  };
}

function createRegisteredRegbot(config, redisStore, addresses) {
  const rb = new Regbot(logger, config);
  rb.status = 'registered';
  rb.addresses = addresses;
  rb.timer = setTimeout(() => {}, 600000);
  for (const ip of addresses) {
    redisStore.createEphemeralGateway(ip, rb.voip_carrier_sid, 3600);
  }
  return rb;
}

function makeConfig(overrides) {
  return Object.assign({
    voip_carrier_sid: 'carrier-aaa',
    ipv4: '10.1.1.1',
    port: 5060,
    username: 'testuser',
    password: 'testpass',
    sip_realm: 'registrar.example.com',
    protocol: 'udp',
    trunk_type: 'reg',
    sip_gateway_sid: 'gw-111',
  }, overrides);
}

/**
 * Simulate one invocation of updateCarrierRegbots's rebuild logic.
 *
 * @param {Array} regbots       - The shared regbots array (module-level state)
 * @param {Array} gatewayConfigs - The gateways returned by the DB query for this invocation
 * @param {Object} srf          - Mock srf
 * @param {Object} redisStore   - Mock Redis
 * @returns {Promise}
 */
async function simulateRebuild(regbots, gatewayConfigs, srf, redisStore) {
  // Build maps of existing regbots (mirrors updateCarrierRegbots logic)
  const existingByKey = new Map();
  for (const rb of regbots) {
    existingByKey.set(rb.configKey(), rb);
  }

  const newRegbots = [];
  const newCarrierSids = new Set();
  const keepKeys = new Set();

  for (const cfg of gatewayConfigs) {
    const key = Regbot.configKeyFromOpts(cfg);
    if (existingByKey.has(key)) {
      const existing = existingByKey.get(key);
      newRegbots.push(existing);
      newCarrierSids.add(existing.voip_carrier_sid);
      keepKeys.add(key);
    } else {
      const rb = new Regbot(logger, cfg);
      newRegbots.push(rb);
      newCarrierSids.add(rb.voip_carrier_sid);
      // Simulate start: set up timer and ephemeral gateways
      rb.status = 'registered';
      rb.addresses = [cfg.ipv4];
      rb.timer = setTimeout(() => {}, 600000);
      redisStore.createEphemeralGateway(cfg.ipv4, rb.voip_carrier_sid, 3600);
    }
  }

  // Stop old regbots not in keepKeys
  for (const [key, rb] of existingByKey) {
    if (!keepKeys.has(key)) {
      const hasReplacement = newCarrierSids.has(rb.voip_carrier_sid);
      if (hasReplacement) {
        rb.stopTimer();
      } else {
        rb.stop(srf);
      }
    }
  }

  // Replace the shared array
  regbots.length = 0;
  for (const rb of newRegbots) regbots.push(rb);
}


// ---------------------------------------------------------------------------
// Bug demonstration: concurrent rebuilds with different DB views
// ---------------------------------------------------------------------------

test('Concurrent rebuild bug: second invocation kills regbot placed by first', async(t) => {
  const redis = createRedisStore();
  const srf = createMockSrf(redis);

  // Shared module-level state
  const regbots = [];

  const configA = makeConfig({
    voip_carrier_sid: 'carrier-aaa', ipv4: '10.1.1.1', sip_gateway_sid: 'gw-111'
  });

  // --- Invocation 1 sees carrier-aaa (Vapi just added it) ---
  // --- Invocation 2 sees NO carriers (DB query returned stale data) ---
  // Both run concurrently with no mutex.

  // Invocation 1 completes first: creates regbot, puts it in array
  await simulateRebuild(regbots, [configA], srf, redis);

  t.equal(regbots.length, 1, 'after invocation 1: 1 regbot in array');
  t.ok(regbots[0].timer, 'after invocation 1: regbot has active timer');
  t.ok(redis.hasGateway('10.1.1.1', 'carrier-aaa'), 'after invocation 1: gateway in Redis');

  // Save reference to the regbot that invocation 1 created
  const regbotFromInvocation1 = regbots[0];

  // Invocation 2 runs concurrently — sees empty carrier list.
  // It reads the SAME regbots array (which now has invocation 1's regbot)
  // and treats it as "old" since its DB query returned no carriers.
  // It calls stop() on invocation 1's regbot.
  await simulateRebuild(regbots, [], srf, redis);

  t.equal(regbots.length, 0, 'BUG: invocation 2 wiped the array');
  t.equal(regbotFromInvocation1.timer, null,
    'BUG: invocation 2 killed the timer on invocation 1\'s regbot');
  t.notOk(redis.hasGateway('10.1.1.1', 'carrier-aaa'),
    'BUG: invocation 2 deleted the gateway — carrier is now unreachable');

  // The regbot is dead. No timer means no re-registration, no recovery.
  // The next checkStatus (60s later) will call updateCarrierRegbots again,
  // but the carrier hash hasn't changed so it may not rebuild, or if it does,
  // it creates a fresh regbot that may hit the same race again.

  t.end();
});


// ---------------------------------------------------------------------------
// Fix demonstration: mutex prevents concurrent execution
// ---------------------------------------------------------------------------

test('Mutex fix: second invocation is skipped, regbot stays alive', async(t) => {
  const redis = createRedisStore();
  const srf = createMockSrf(redis);

  const regbots = [];
  let rebuildInProgress = false;

  const configA = makeConfig({
    voip_carrier_sid: 'carrier-aaa', ipv4: '10.1.1.1', sip_gateway_sid: 'gw-111'
  });

  /**
   * Wrapper that mirrors the fixed updateCarrierRegbots with mutex.
   */
  async function protectedRebuild(gatewayConfigs) {
    if (rebuildInProgress) {
      // This is the fix: skip concurrent invocations
      return 'skipped';
    }
    rebuildInProgress = true;
    try {
      await simulateRebuild(regbots, gatewayConfigs, srf, redis);
      return 'completed';
    } finally {
      rebuildInProgress = false;
    }
  }

  // Invocation 1 sees carrier-aaa
  const result1 = await protectedRebuild([configA]);
  t.equal(result1, 'completed', 'invocation 1 completed');
  t.equal(regbots.length, 1, 'after invocation 1: 1 regbot in array');

  const regbotFromInvocation1 = regbots[0];

  // Simulate: invocation 1 is still "in progress" when invocation 2 arrives.
  // In real code, this happens because invocation 1 is awaiting a slow DB query
  // or sleepFor() in the batch loop while invocation 2 is triggered.
  rebuildInProgress = true;

  const result2 = await protectedRebuild([]);
  t.equal(result2, 'skipped', 'invocation 2 was SKIPPED by mutex');

  // Reset for next cycle
  rebuildInProgress = false;

  // The regbot from invocation 1 is untouched
  t.equal(regbots.length, 1, 'regbot array still has 1 entry');
  t.equal(regbots[0], regbotFromInvocation1, 'same regbot instance');
  t.ok(regbotFromInvocation1.timer, 'timer still active — not killed');
  t.ok(redis.hasGateway('10.1.1.1', 'carrier-aaa'),
    'gateway still in Redis — carrier remains reachable');

  // Clean up timer
  clearTimeout(regbotFromInvocation1.timer);
  t.end();
});


// ---------------------------------------------------------------------------
// Verify: sequential rebuilds still work after mutex releases
// ---------------------------------------------------------------------------

test('Mutex releases after completion: next rebuild runs normally', async(t) => {
  const redis = createRedisStore();
  const srf = createMockSrf(redis);

  const regbots = [];
  let rebuildInProgress = false;

  const configA = makeConfig({
    voip_carrier_sid: 'carrier-aaa', ipv4: '10.1.1.1', sip_gateway_sid: 'gw-111'
  });
  const configB = makeConfig({
    voip_carrier_sid: 'carrier-bbb', ipv4: '10.2.2.2', sip_gateway_sid: 'gw-222',
    username: 'userB', password: 'passB'
  });

  async function protectedRebuild(gatewayConfigs) {
    if (rebuildInProgress) return 'skipped';
    rebuildInProgress = true;
    try {
      await simulateRebuild(regbots, gatewayConfigs, srf, redis);
      return 'completed';
    } finally {
      rebuildInProgress = false;
    }
  }

  // Rebuild 1: create carrier-aaa
  const r1 = await protectedRebuild([configA]);
  t.equal(r1, 'completed', 'rebuild 1 completed');
  t.equal(regbots.length, 1, 'after rebuild 1: 1 regbot');

  // Rebuild 2 (sequential, not concurrent): add carrier-bbb
  const r2 = await protectedRebuild([configA, configB]);
  t.equal(r2, 'completed', 'rebuild 2 completed (mutex released correctly)');
  t.equal(regbots.length, 2, 'after rebuild 2: 2 regbots');
  t.ok(redis.hasGateway('10.1.1.1', 'carrier-aaa'), 'carrier-aaa gateway present');
  t.ok(redis.hasGateway('10.2.2.2', 'carrier-bbb'), 'carrier-bbb gateway present');

  // Rebuild 3: remove carrier-aaa
  const r3 = await protectedRebuild([configB]);
  t.equal(r3, 'completed', 'rebuild 3 completed');
  t.equal(regbots.length, 1, 'after rebuild 3: 1 regbot');
  t.notOk(redis.hasGateway('10.1.1.1', 'carrier-aaa'), 'carrier-aaa removed');
  t.ok(redis.hasGateway('10.2.2.2', 'carrier-bbb'), 'carrier-bbb still present');

  // Clean up
  for (const rb of regbots) clearTimeout(rb.timer);
  t.end();
});


// ---------------------------------------------------------------------------
// Verify: mutex releases even when rebuild throws
// ---------------------------------------------------------------------------

test('Mutex releases on error: finally block ensures recovery', async(t) => {
  const redis = createRedisStore();
  const srf = createMockSrf(redis);

  const regbots = [];
  let rebuildInProgress = false;

  const configA = makeConfig({
    voip_carrier_sid: 'carrier-aaa', ipv4: '10.1.1.1', sip_gateway_sid: 'gw-111'
  });

  async function protectedRebuild(gatewayConfigs, shouldThrow) {
    if (rebuildInProgress) return 'skipped';
    rebuildInProgress = true;
    try {
      if (shouldThrow) throw new Error('simulated DB error');
      await simulateRebuild(regbots, gatewayConfigs, srf, redis);
      return 'completed';
    } catch (err) {
      return 'error';
    } finally {
      rebuildInProgress = false;
    }
  }

  // Rebuild that throws
  const r1 = await protectedRebuild([], true);
  t.equal(r1, 'error', 'rebuild 1 hit error');
  t.equal(rebuildInProgress, false, 'mutex released despite error (finally block)');

  // Next rebuild succeeds
  const r2 = await protectedRebuild([configA]);
  t.equal(r2, 'completed', 'rebuild 2 completed — not stuck behind dead mutex');
  t.equal(regbots.length, 1, 'regbot was created');

  // Clean up
  for (const rb of regbots) clearTimeout(rb.timer);
  t.end();
});
