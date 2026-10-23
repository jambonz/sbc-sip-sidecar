const test = require('tape');
const Srf = require('drachtio-srf');
const clearModule = require('clear-module');

/**
 * A client (a second drachtio server, 172.39.0.70) registers with the sbc over udp, tcp and tls.
 * For each transport we check what the sidecar stores, that a re-REGISTER on the same flow is
 * answered from the cache, and that an INVITE sent the way sbc-outbound sends it (request-uri =
 * registered contact, proxy = stored proxy) reaches the client over the transport it registered on.
 *
 * drachtio remembers the connection a REGISTER arrived on, keyed by the Contact's user@host, and
 * sends a later INVITE to that same user@host over it whatever the proxy says. The proxy decides
 * the transport only when the request-uri user differs from the Contact's, which is what
 * sbc-outbound does for dial `overrideTo` (X-Override-To), so both cases are covered.
 */

const SBC = '172.39.0.10';
const CLIENT = '172.39.0.70';
const AOR = 'john@jambonz.org';
const AUTH = {username: 'john', password: '1234'};

const flows = [
  {
    transport: 'udp',
    registrar: `sip:${SBC}:5060`,
    contact: `sip:john@${CLIENT}:5060`,
    proxy: /^sip:172\.39\.0\.70:5060$/
  },
  {
    transport: 'tcp',
    registrar: `sip:${SBC}:5060;transport=tcp`,
    contact: `sip:john@${CLIENT}:5060;transport=tcp`,
    proxy: /^sip:172\.39\.0\.70:\d+;transport=tcp$/
  },
  {
    transport: 'tls',
    registrar: `sip:${SBC}:5061;transport=tls`,
    contact: `sip:john@${CLIENT}:5061;transport=tls`,
    proxy: /^sip:172\.39\.0\.70:\d+;transport=tls$/
  }
];

const connect = (srf) => new Promise((resolve) => srf.on('connect', () => resolve()));

/* send a REGISTER from the client and resolve with the final response status */
const register = async(client, flow, {auth, expires = 3600} = {}) => {
  const req = await client.request('sip:jambonz.org', {
    method: 'REGISTER',
    proxy: flow.registrar,
    headers: {
      'From': `<sip:${AOR}>`,
      'To': `<sip:${AOR}>`,
      'Contact': `<${flow.contact}>;expires=${expires}`,
      'Expires': expires,
      'Call-ID': `reg-${flow.transport}-${Date.now()}`
    },
    ...(auth && {auth})
  });
  return new Promise((resolve) => {
    req.on('response', (res) => {
      if (res.status >= 200) resolve(res.status);
    });
  });
};

test('calls to registered clients use the transport they registered on', async(t) => {
  t.timeoutAfter(60000);
  clearModule.all();
  const {srf} = require('../app');
  const client = new Srf();
  client.connect({host: '127.0.0.1', port: 9023, secret: 'cymru'});

  const received = [];
  client.invite((req, res) => {
    received.push({protocol: req.protocol, uri: req.uri});
    res.send(486);
  });

  try {
    await Promise.all([connect(srf), connect(client)]);
    const {registrar} = srf.locals;

    for (const flow of flows) {
      const {transport} = flow;

      let status = await register(client, flow, {auth: AUTH});
      t.equal(status, 200, `${transport}: registered`);

      let reg = await registrar.query(AOR);
      t.ok(flow.proxy.test(reg.proxy), `${transport}: stored proxy ${reg.proxy}`);
      t.equal(reg.protocol, transport, `${transport}: stored protocol`);

      /* no credentials: a 200 can only come from the cached-registration check */
      status = await register(client, flow);
      t.equal(status, 200, `${transport}: re-REGISTER on the same flow is answered from the cache`);

      /* send the call the way sbc-outbound does for a registered user, to the registered contact
         and with the user overridden as for X-Override-To */
      const overridden = reg.contact.replace(/^sip:john@/, 'sip:213@');
      for (const [label, uri] of [['contact', reg.contact], ['overrideTo', overridden]]) {
        received.length = 0;
        try {
          await srf.createUAC(uri, {proxy: reg.proxy, localSdp: 'v=0\r\n'});
          t.fail(`${transport}/${label}: expected the client to reject the INVITE`);
        } catch (err) {
          t.equal(err.status, 486, `${transport}/${label}: INVITE to ${uri} reached the client (it answered 486)`);
        }
        t.equal(received.length, 1, `${transport}/${label}: client received exactly one INVITE`);
        t.equal(received[0] && received[0].protocol, transport,
          `${transport}/${label}: INVITE arrived over ${transport}`);
      }

      if (transport !== 'udp') {
        /* an entry written by an older sidecar has no transport on the proxy; it must not be
           served from the cache, and the next authenticated REGISTER rewrites it */
        const bare = reg.proxy.replace(/;transport=\w+$/, '');
        await registrar.add(AOR, {...reg, proxy: bare}, 3600);
        status = await register(client, flow);
        t.equal(status, 401, `${transport}: entry without a transport is not served from the cache`);
        status = await register(client, flow, {auth: AUTH});
        t.equal(status, 200, `${transport}: re-registered with credentials`);
        reg = await registrar.query(AOR);
        t.ok(flow.proxy.test(reg.proxy), `${transport}: entry rewritten with the transport: ${reg.proxy}`);
      }

      status = await register(client, flow, {auth: AUTH, expires: 0});
      t.equal(status, 200, `${transport}: unregistered`);
      t.notOk(await registrar.query(AOR), `${transport}: registration removed`);
    }
  } catch (err) {
    t.error(err);
  }
  client.disconnect();
  if (srf.locals.lb) srf.locals.lb.disconnect();
  srf.disconnect();
  t.end();
});
