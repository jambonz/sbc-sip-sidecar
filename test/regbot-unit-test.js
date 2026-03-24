const test = require('tape');
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
  const baseKey = new Regbot(logger, base).configKey();

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
    const key = new Regbot(logger, {...base, ...override}).configKey();
    t.notEqual(key, baseKey, `changing ${Object.keys(override)[0]} produces a different key`);
  }
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
  t.end();
});
