const test = require('tape');
const {getRegisteredProxy} = require('../lib/utils');

const makeReq = (protocol, source_address = '203.0.113.10', source_port = 50248) => ({
  protocol, source_address, source_port
});

test('registered proxy: connection-oriented transports carry an explicit transport', (t) => {
  t.equal(getRegisteredProxy(makeReq('tcp')), 'sip:203.0.113.10:50248;transport=tcp', 'tcp');
  t.equal(getRegisteredProxy(makeReq('tls')), 'sip:203.0.113.10:50248;transport=tls', 'tls');
  t.equal(getRegisteredProxy(makeReq('TLS')), 'sip:203.0.113.10:50248;transport=tls', 'uppercase TLS is normalized');
  t.equal(getRegisteredProxy(makeReq('Tcp')), 'sip:203.0.113.10:50248;transport=tcp', 'mixed-case TCP is normalized');
  t.end();
});

test('registered proxy: other transports are stored unchanged', (t) => {
  t.equal(getRegisteredProxy(makeReq('udp', '203.0.113.10', 5060)), 'sip:203.0.113.10:5060', 'udp');
  t.equal(getRegisteredProxy(makeReq('ws')), 'sip:203.0.113.10:50248', 'ws');
  t.equal(getRegisteredProxy(makeReq('wss')), 'sip:203.0.113.10:50248', 'wss');
  t.equal(getRegisteredProxy(makeReq(undefined)), 'sip:203.0.113.10:50248', 'missing protocol');
  t.equal(getRegisteredProxy(makeReq('sctp')), 'sip:203.0.113.10:50248', 'unknown protocol');
  t.end();
});

test('registered proxy: the transport follows the flow, not the source address', (t) => {
  const a = getRegisteredProxy(makeReq('tcp', '198.51.100.7', 40000));
  const b = getRegisteredProxy(makeReq('tcp', '198.51.100.7', 40001));
  t.notEqual(a, b, 'a new tcp connection (new source port) yields a different proxy');
  t.equal(a, getRegisteredProxy(makeReq('tcp', '198.51.100.7', 40000)),
    'the same flow yields an identical proxy, so the cached-registration check matches');
  t.notEqual(getRegisteredProxy(makeReq('udp', '198.51.100.7', 40000)), a,
    'the same address and port over a different transport is a different flow');
  t.end();
});
