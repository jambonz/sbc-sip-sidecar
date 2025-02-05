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
