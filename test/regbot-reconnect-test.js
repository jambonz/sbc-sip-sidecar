const test = require('tape');
const { EventEmitter } = require('events');
const clearModule = require('clear-module');
const {
  JAMBONES_LOGLEVEL,
} = require('../lib/config');
const opts = Object.assign({
  timestamp: () => { return `, "time": "${new Date().toISOString()}"`; }
}, { level: JAMBONES_LOGLEVEL || 'info' });
const logger = require('pino')(opts);

/**
 * Tests for drachtio-reconnect recovery (resync) in lib/sip-trunk-register.js.
 *
 * When the drachtio server restarts, the sidecar keeps running but the regbots'
 * SIP state on the (restarted) server is gone. Previously nothing re-registered
 * them: the reconnect path was guarded out by `initialized`, and
 * updateCarrierRegbots only rebuilds on a config-hash change. resync() is the
 * new entrypoint the reconnect handler calls.
 */

const tick = () => new Promise((resolve) => setImmediate(resolve));

// a mock srf that records each REGISTER and serves one carrier/gateway from the db-helpers
function makeSrf({ active }) {
  const state = { requests: [] };
  const carriers = [{
    voip_carrier_sid: 'c1',
    requires_register: 1,
    is_active: 1,
    register_username: 'user',
    register_password: 'pass',
    register_sip_realm: 'registrar.example.com',
    register_public_ip_in_contact: 1,   // avoids the account-realm lookup path
    trunk_type: 'static_ip',            // avoids the reg-trunk DNS/ephemeral-gateway path
    account_sid: null
  }];
  const gateways = [{
    sip_gateway_sid: 'gw1',
    voip_carrier_sid: 'c1',
    ipv4: '10.1.1.1',
    port: 5060,
    protocol: 'udp',
    outbound: 1,
    is_active: 1
  }];
  const srf = {
    request: () => {
      const req = new EventEmitter();
      req.get = () => '';
      state.requests.push(req);
      return Promise.resolve(req);
    },
    locals: {
      regbot: { active, myToken: 'tok' },
      sbcPublicIpAddress: { udp: '203.0.113.1:5060' },
      localSIPDomain: 'sbc.example.com',
      writeAlerts: () => {},
      realtimeDbHelpers: {
        createEphemeralGateway: () => Promise.resolve(),
        deleteEphemeralGateway: () => Promise.resolve()
      },
      dbHelpers: {
        updateVoipCarriersRegisterStatus: () => {},
        lookupAllVoipCarriers: () => Promise.resolve(carriers),
        lookupSipGatewaysByCarrier: () => Promise.resolve(gateways),
        lookupAccountBySid: () => Promise.resolve(null)
      }
    }
  };
  return { srf, state };
}

test('resync is a no-op when this instance is not the active regbot holder', async(t) => {
  clearModule('../lib/sip-trunk-register');
  const reg = require('../lib/sip-trunk-register');
  const { srf, state } = makeSrf({ active: false });

  await reg.resync(logger, srf);
  await tick();

  t.equal(state.requests.length, 0, 'no REGISTER sent when not active');
  reg._resetForTest();
  t.end();
});

test('resync rebuilds regbots when active but the array is empty (post-clear recovery)', async(t) => {
  clearModule('../lib/sip-trunk-register');
  const reg = require('../lib/sip-trunk-register');
  const { srf, state } = makeSrf({ active: true });

  // empty regbots + active holder -> resync resets hashes and forces a rebuild
  await reg.resync(logger, srf);
  await tick();
  await tick();
  t.equal(state.requests.length, 1, 'a regbot was rebuilt and sent a REGISTER');

  // a subsequent reconnect finds a non-empty array -> re-registers the existing regbot
  await reg.resync(logger, srf);
  await tick();
  t.ok(state.requests.length >= 2, 'resync re-registered the existing regbot on the next reconnect');

  reg._resetForTest();
  t.end();
});
