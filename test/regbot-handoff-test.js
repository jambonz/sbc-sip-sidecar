const test = require('tape');
const { EventEmitter } = require('events');
const Regbot = require('../lib/regbot');
const sipTrunkRegister = require('../lib/sip-trunk-register');
const { JAMBONES_LOGLEVEL } = require('../lib/config');
const logger = require('pino')({ level: JAMBONES_LOGLEVEL || 'info' });

const FAST = { pollMs: 5, timeoutMs: 100, graceMs: 0 };

function makeSrf({ active = true, successorAfterMs } = {}) {
  const state = { keys: {}, deleted: [], requests: [] };
  const regbotKey = 'default:regbot-token';
  state.keys[regbotKey] = active ? 'me' : 'other';
  const srf = {
    request: (uri, opts) => {
      const req = new EventEmitter();
      req.opts = opts;
      state.requests.push(req);
      return Promise.resolve(req);
    },
    locals: {
      regbot: { myToken: 'me', active },
      sbcPublicIpAddress: { udp: '203.0.113.1:5060' },
      realtimeDbHelpers: {
        retrieveKey: (k) => Promise.resolve(state.keys[k]),
        deleteKey: (k) => {
          state.deleted.push(k);
          delete state.keys[k];
          if (successorAfterMs !== undefined) {
            setTimeout(() => { state.keys[k] = 'successor'; }, successorAfterMs);
          }
          return Promise.resolve(true);
        }
      }
    }
  };
  return { srf, state };
}

function addRegbot(overrides) {
  const rb = new Regbot(logger, Object.assign({
    voip_carrier_sid: 'carrier-1', ipv4: '2.3.4.5', port: 5060, username: 'user', password: 'pw',
    sip_realm: 'sip.server.com', protocol: 'udp', trunk_type: 'static_ip', sip_gateway_sid: 'gw-1'
  }, overrides));
  rb.status = 'registered';
  rb.timer = setTimeout(() => {}, 600000);
  sipTrunkRegister._addForTest(rb);
  return rb;
}

test('handoff: an SBC that is not the regbot holder only marks itself draining', async(t) => {
  sipTrunkRegister._resetForTest();
  const { srf, state } = makeSrf({ active: false });

  await sipTrunkRegister.handoff(logger, srf, FAST);

  t.equal(srf.locals.regbot.draining, true, 'marked draining so it never claims the role');
  t.deepEqual(state.deleted, [], 'did not touch the lease');
  t.end();
});

test('handoff: releases the role, then un-registers only bindings that point at this SBC', async(t) => {
  sipTrunkRegister._resetForTest();
  const { srf, state } = makeSrf({ successorAfterMs: 20 });
  const ipContact = addRegbot({ use_public_ip_in_contact: true, sip_gateway_sid: 'gw-ip' });
  const sharedContact = addRegbot({ sip_gateway_sid: 'gw-realm', username: 'other' });

  await sipTrunkRegister.handoff(logger, srf, FAST);

  t.equal(srf.locals.regbot.active, false, 'no longer the regbot holder');
  t.equal(srf.locals.regbot.draining, true, 'marked draining');
  t.deepEqual(state.deleted, ['default:regbot-token'], 'released the lease');
  t.ok(ipContact.retired && !ipContact.timer && sharedContact.retired && !sharedContact.timer,
    'refresh timers stopped');
  t.equal(state.requests.length, 1, 'one un-REGISTER sent');
  t.equal(state.requests[0].opts.headers['Call-ID'], 'gw-ip@203.0.113.1',
    'for the binding whose Contact carries our address');
  t.equal(state.requests[0].opts.headers['Expires'], 0, 'with Expires: 0');
  t.end();
});

test('handoff: with no successor, bindings are left to expire', async(t) => {
  sipTrunkRegister._resetForTest();
  const { srf, state } = makeSrf();
  addRegbot({ use_public_ip_in_contact: true });

  await sipTrunkRegister.handoff(logger, srf, FAST);

  t.deepEqual(state.deleted, ['default:regbot-token'], 'released the lease');
  t.equal(state.requests.length, 0, 'no un-REGISTER sent');
  t.end();
});

test('aws-lifecycle: fires once when IMDS target-lifecycle-state reads Terminated', async(t) => {
  const realFetch = global.fetch;
  const states = ['InService', 'InService', 'Terminated', 'Terminated'];
  const calls = [];
  global.fetch = (url, opts) => {
    calls.push({url, opts});
    const body = url.endsWith('/api/token') ? 'tok' : states.shift() || 'Terminated';
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(body) });
  };

  let fired = 0;
  require('../lib/aws-lifecycle')(logger, () => fired++, { interval: 5 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  global.fetch = realFetch;

  t.equal(fired, 1, 'scale-in callback fired exactly once');
  const get = calls.find((c) => c.url.endsWith('autoscaling/target-lifecycle-state'));
  t.equal(get.opts.headers['X-aws-ec2-metadata-token'], 'tok', 'IMDSv2 session token presented');
  t.equal(calls[0].opts.method, 'PUT', 'token fetched with PUT');
  t.end();
});
