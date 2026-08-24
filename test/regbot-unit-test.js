const test = require('tape');
const { EventEmitter } = require('events');
const clearModule = require('clear-module');
const Regbot = require('../lib/regbot');
const {
  JAMBONES_LOGLEVEL,
} = require('../lib/config');
const opts = Object.assign({
  timestamp: () => { return `, "time": "${new Date().toISOString()}"`; }
}, { level:JAMBONES_LOGLEVEL || 'info' });
const logger = require('pino')(opts);

test('Cannot create regbot with invalid sip_realm', (t) => {
  try {
    
    new Regbot(logger, {
      ipv4: '2.3.4.5',
      port: 5060,
      username: 'user',
      password: 'password',
      sip_realm: 'sip:1.2.3.4',
      protocol: 'udp',
    });
    t.fail('Regbot created with invalid sip_realm');
  } catch (err) {
    t.ok(err, 'Error received, regbot cannot be created with invalid sip_realm');
  }
  t.end();
});


test('Can create regbot with valid sip_realm', (t) => {
  try {
    new Regbot(logger, {
      ipv4: '2.3.4.5',
      port: 5060,
      username: 'user',
      password: 'password',
      sip_realm: '1.2.3.4',
      protocol: 'udp',
    });

    new Regbot(logger, {
      ipv4: '2.3.4.5',
      port: 5060,
      username: 'user',
      password: 'password',
      sip_realm: '1.2.3.4:5060',
      protocol: 'udp',
    });

    new Regbot(logger, {
      ipv4: '2.3.4.5',
      port: 5060,
      username: 'user',
      password: 'password',
      sip_realm: 'sip.server.com',
      protocol: 'udp',
    });

    new Regbot(logger, {
      ipv4: '2.3.4.5',
      port: 5060,
      username: 'user',
      password: 'password',
      sip_realm: 'sip.server.com:5068',
      protocol: 'udp',
    });
    
    t.ok('Regbot can be created with valid sip_realm');
  
  } catch (err) {
    t.fail('Regbot is not created with valid sip_realm');}
  t.end();
});

test('configKey returns identical strings for identical config', (t) => {
  const config = {
    voip_carrier_sid: 'carrier-1',
    ipv4: '2.3.4.5',
    port: 5060,
    username: 'user',
    password: 'password',
    sip_realm: 'sip.server.com',
    protocol: 'udp',
    account_sip_realm: 'example.com',
    trunk_type: 'reg',
    sip_gateway_sid: 'gw-1'
  };
  const rb1 = new Regbot(logger, config);
  const rb2 = new Regbot(logger, config);
  t.equal(rb1.configKey(), rb2.configKey(), 'identical config produces identical keys');
  t.end();
});

test('static configKeyFromOpts matches instance configKey', (t) => {
  const config = {
    voip_carrier_sid: 'carrier-1',
    ipv4: '2.3.4.5',
    port: 5060,
    username: 'user',
    password: 'password',
    sip_realm: 'sip.server.com',
    protocol: 'udp',
    account_sip_realm: 'example.com',
    trunk_type: 'reg',
    sip_gateway_sid: 'gw-1'
  };
  const rb = new Regbot(logger, config);
  t.equal(Regbot.configKeyFromOpts(config), rb.configKey(),
    'static method produces same key as instance method');

  // also with from_user and from_domain overrides
  const config2 = {...config, from_user: 'alice', from_domain: 'example.org'};
  const rb2 = new Regbot(logger, config2);
  t.equal(Regbot.configKeyFromOpts(config2), rb2.configKey(),
    'static method matches instance with from_user/from_domain');
  t.end();
});

test('configKey returns different strings when config differs', (t) => {
  const base = {
    voip_carrier_sid: 'carrier-1',
    ipv4: '2.3.4.5',
    port: 5060,
    username: 'user',
    password: 'password',
    sip_realm: 'sip.server.com',
    protocol: 'udp',
    trunk_type: 'reg',
    sip_gateway_sid: 'gw-1'
  };
  const baseKey = Regbot.configKeyFromOpts(base);

  // each of these should produce a different key
  const variants = [
    {password: 'newpass'},
    {username: 'other'},
    {ipv4: '9.9.9.9'},
    {port: 5080},
    {sip_realm: 'other.com'},
    {voip_carrier_sid: 'carrier-2'},
    {sip_gateway_sid: 'gw-2'},
    {from_user: 'override'},
    {from_domain: 'custom.com'}
  ];
  for (const override of variants) {
    const key = Regbot.configKeyFromOpts({...base, ...override});
    t.notEqual(key, baseKey, `changing ${Object.keys(override)[0]} produces a different key`);
  }
  t.end();
});

test('getOwnContactExpires: picks our own binding when registrar returns multiple contacts', (t) => {
  const getOwnContactExpires = Regbot._getOwnContactExpires;

  // reproduces EMF capture: AoR 9955 has another device registered against it (rinstance
  // contact with a counting-down expires). Our own contact is always granted 300.
  const contacts = [
    {uri: 'sip:9955@192.168.1.50:15447;rinstance=D4077321', params: {expires: '18', received: '"sip:192.168.100.186:15447"'}},
    {uri: 'sip:9955@example.com;transport=udp', params: {expires: '300'}}
  ];
  t.equal(getOwnContactExpires(contacts, 'sip:9955@example.com'), 300,
    'returns our own binding expires (300), not the other device countdown (18)');

  // order should not matter
  const reversed = [contacts[1], contacts[0]];
  t.equal(getOwnContactExpires(reversed, 'sip:9955@example.com'), 300,
    'matches our contact regardless of position in the header');

  // host match is case-insensitive
  t.equal(getOwnContactExpires(contacts, 'sip:9955@EXAMPLE.COM'), 300,
    'host comparison is case-insensitive');

  t.end();
});

test('getOwnContactExpires: returns undefined when our contact is absent', (t) => {
  const getOwnContactExpires = Regbot._getOwnContactExpires;
  const contacts = [
    {uri: 'sip:9955@192.168.1.50:15447;rinstance=D4077321', params: {expires: '18'}}
  ];
  t.equal(getOwnContactExpires(contacts, 'sip:9955@example.com'), undefined,
    'no match -> undefined so caller can fall back to Expires header / single-contact');

  t.equal(getOwnContactExpires([], 'sip:9955@example.com'), undefined,
    'empty contact list -> undefined');
  t.end();
});

test('getOwnContactExpires: single matching contact returns its expires', (t) => {
  const getOwnContactExpires = Regbot._getOwnContactExpires;
  // AoR 25337 in the same capture: only our binding present
  const contacts = [
    {uri: 'sip:25337@example.com;transport=udp', params: {expires: '300'}}
  ];
  t.equal(getOwnContactExpires(contacts, 'sip:25337@example.com'), 300,
    'single own binding resolves correctly');
  t.end();
});

test('stopTimer clears timer without deleting gateways', (t) => {
  const rb = new Regbot(logger, {
    voip_carrier_sid: 'carrier-1',
    ipv4: '2.3.4.5',
    port: 5060,
    username: 'user',
    password: 'password',
    sip_realm: 'sip.server.com',
    protocol: 'udp',
  });

  // simulate a running timer
  rb.timer = setTimeout(() => {}, 60000);
  rb.addresses = ['1.2.3.4'];

  rb.stopTimer();

  t.equal(rb.timer, null, 'timer is cleared');
  t.deepEqual(rb.addresses, ['1.2.3.4'], 'addresses are preserved');
  t.equal(rb.retired, true, 'retired flag is set');
  t.end();
});

test('stop sets retired flag', (t) => {
  const rb = new Regbot(logger, {
    voip_carrier_sid: 'carrier-1',
    ipv4: '2.3.4.5',
    port: 5060,
    username: 'user',
    password: 'password',
    sip_realm: 'sip.server.com',
    protocol: 'udp',
  });

  const srf = {
    locals: {
      realtimeDbHelpers: {
        deleteEphemeralGateway: () => Promise.resolve()
      }
    }
  };

  rb.timer = setTimeout(() => {}, 60000);
  rb.stop(srf);

  t.equal(rb.retired, true, 'retired flag is set');
  t.equal(rb.timer, null, 'timer is cleared');
  t.end();
});

/* ---- re-registration / drachtio-reconnect recovery tests ---- */

const REGBOT_OPTS = {
  voip_carrier_sid: 'carrier-1',
  ipv4: '2.3.4.5',
  port: 5060,
  username: 'user',
  password: 'password',
  sip_realm: 'sip.server.com',
  protocol: 'udp',
  trunk_type: 'static_ip',   // avoid the reg-trunk DNS/ephemeral-gateway path
  sip_gateway_sid: 'gw-1'
};

// a mock srf whose request() records each REGISTER and returns a controllable fake req
function makeSrf() {
  const state = { requests: [], statusUpdates: [] };
  const srf = {
    request: (uri, opts) => {
      const req = new EventEmitter();
      req.get = () => '';
      req.uri = uri;
      req.opts = opts;
      state.requests.push(req);
      return Promise.resolve(req);
    },
    locals: {
      sbcPublicIpAddress: { udp: '203.0.113.1:5060' },
      localSIPDomain: 'sbc.example.com',
      writeAlerts: () => {},
      realtimeDbHelpers: {
        createEphemeralGateway: () => Promise.resolve(),
        deleteEphemeralGateway: () => Promise.resolve()
      },
      dbHelpers: {
        updateVoipCarriersRegisterStatus: (sid, s) => state.statusUpdates.push(s)
      }
    }
  };
  return { srf, state };
}

const ok200 = { status: 200, reason: 'OK', has: () => false, get: () => undefined, getParsedHeader: () => [] };
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('reregister sends a fresh REGISTER and re-arms the timer on 200 OK', async(t) => {
  const { srf, state } = makeSrf();
  const rb = new Regbot(logger, REGBOT_OPTS);
  // pretend a stale re-register timer is pending from before the drachtio restart
  rb.timer = setTimeout(() => t.fail('stale timer should have been cleared'), 600000);
  const prevEpoch = rb.epoch;

  rb.reregister(srf);
  await tick();

  t.equal(state.requests.length, 1, 'a REGISTER was sent');
  t.ok(rb.watchdog, 'response watchdog is armed while awaiting the response');
  t.ok(rb.epoch > prevEpoch, 'attempt epoch advanced');

  state.requests[0].emit('response', ok200);
  await tick();

  t.equal(rb.status, 'registered', 'status is registered after 200 OK');
  t.equal(rb.watchdog, null, 'watchdog is cleared once the response arrives');
  t.ok(rb.timer, 'next re-register timer is armed');
  clearTimeout(rb.timer);
  t.end();
});

test('reregister on a retired regbot is a no-op', async(t) => {
  const { srf, state } = makeSrf();
  const rb = new Regbot(logger, REGBOT_OPTS);
  rb.retired = true;

  rb.reregister(srf);
  await tick();

  t.equal(state.requests.length, 0, 'no REGISTER is sent for a retired regbot');
  t.notOk(rb.timer, 'no timer is armed');
  t.end();
});

test('a stale REGISTER response (superseded by a newer attempt) is ignored', async(t) => {
  const { srf, state } = makeSrf();
  const rb = new Regbot(logger, REGBOT_OPTS);

  rb.register(srf);            // attempt 1
  await tick();
  const req1 = state.requests[0];

  rb.reregister(srf);          // attempt 2 supersedes attempt 1
  await tick();
  const req2 = state.requests[1];
  t.ok(req2 && req2 !== req1, 'a second REGISTER was sent by reregister');

  // a late response to attempt 1 must not be acted on
  req1.emit('response', ok200);
  await tick();
  t.notEqual(rb.status, 'registered', 'stale response did not mark the regbot registered');
  t.ok(rb.watchdog, 'the current attempt watchdog is still armed after the stale response');

  // the real response to attempt 2 is processed normally
  req2.emit('response', ok200);
  await tick();
  t.equal(rb.status, 'registered', 'current attempt response is processed');
  t.equal(rb.watchdog, null, 'watchdog cleared by the current response');
  clearTimeout(rb.timer);
  t.end();
});

test('watchdog re-sends REGISTER when no SIP response arrives', async(t) => {
  // reload regbot with a short response timeout so the watchdog fires quickly
  process.env.JAMBONES_REGBOT_RESPONSE_TIMEOUT = '40';
  clearModule('../lib/config');
  clearModule('../lib/regbot');
  const RegbotFresh = require('../lib/regbot');

  const { srf, state } = makeSrf();
  const rb = new RegbotFresh(logger, REGBOT_OPTS);

  rb.register(srf);           // no response is ever emitted
  await tick();
  t.equal(state.requests.length, 1, 'first REGISTER sent');

  await new Promise((resolve) => setTimeout(resolve, 120));
  t.ok(state.requests.length >= 2, 'watchdog retried the REGISTER when no response arrived');

  // stop further retries and restore the module cache for later suites
  rb.retired = true;
  clearTimeout(rb.timer);
  clearTimeout(rb.watchdog);
  clearModule('../lib/config');
  clearModule('../lib/regbot');
  delete process.env.JAMBONES_REGBOT_RESPONSE_TIMEOUT;
  t.end();
});
