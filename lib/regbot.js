const dns = require('dns').promises;
const {
  JAMBONES_REGBOT_DEFAULT_EXPIRES_INTERVAL,
  JAMBONES_REGBOT_MIN_EXPIRES_INTERVAL,
  JAMBONES_REGBOT_CONTACT_USE_IP,
  REGISTER_RESPONSE_REMOVE,
  JAMBONES_REGBOT_USER_AGENT
} = require('./config');
const {isValidDomainOrIP} = require('./utils');
const DEFAULT_EXPIRES = (parseInt(JAMBONES_REGBOT_DEFAULT_EXPIRES_INTERVAL) || 3600);
const MIN_EXPIRES = (parseInt(JAMBONES_REGBOT_MIN_EXPIRES_INTERVAL) || 30);
const assert = require('assert');
const version = require('../package.json').version;
const useragent = JAMBONES_REGBOT_USER_AGENT || `Jambonz ${version}`;

class Regbot {
  constructor(logger, opts) {
    this.logger = logger;

    [
      'voip_carrier_sid',
      'ipv4',
      'port',
      'username',
      'password',
      'protocol',
      'account_sip_realm',
      'outbound_sip_proxy',
      'trunk_type'
    ].forEach((prop) => this[prop] = opts[prop]);

    this.sip_realm = opts.sip_realm || opts.ipv4;
    this.use_public_ip_in_contact = opts.use_public_ip_in_contact || JAMBONES_REGBOT_CONTACT_USE_IP;
    this.use_sips_scheme = opts.use_sips_scheme || false;

    this.fromUser = opts.from_user || this.username;
    const fromDomain = opts.from_domain || this.sip_realm;
    if (!isValidDomainOrIP(fromDomain)) {
      throw new Error(`Invalid from_domain ${fromDomain}`);
    }
    this.from = `sip:${this.fromUser}@${fromDomain}`;
    this.aor = `${this.fromUser}@${this.sip_realm}`;
    this.status = 'none';
  }

  async start(srf) {
    assert(!this.timer);

    this.logger.info(`starting regbot for ${this.fromUser}@${this.sip_realm}`);
    this.register(srf);
  }

  stop(srf) {
    const { deleteEphemeralGateway } = srf.locals.realtimeDbHelpers;
    clearTimeout(this.timer);
    this.timer = null;
    // remove any ephemeral gateways created for this regbot
    if (this.addresses && this.addresses.length) {
      this.addresses.forEach((ip) => {
        deleteEphemeralGateway(ip, this.voip_carrier_sid).catch((err) => {
          this.logger.error({err, ip}, 'Error deleting ephemeral gateway on regbot stop');
        });
      });
    }

  }

  toJSON() {
    return {
      voip_carrier_sid: this.voip_carrier_sid,
      username: this.username,
      fromUser: this.fromUser,
      sip_realm: this.sip_realm,
      ipv4: this.ipv4,
      port: this.port,
      aor: this.aor,
      status: this.status
    };
  }

  async register(srf) {
    const { createEphemeralGateway } = srf.locals.realtimeDbHelpers;
    const { updateVoipCarriersRegisterStatus } = srf.locals.dbHelpers;
    const { writeAlerts, localSIPDomain } = srf.locals;
    try {
      // transport
      const transport = (this.protocol.includes('/') ? this.protocol.substring(0, this.protocol.indexOf('/')) :
        this.protocol).toLowerCase();

      // scheme
      let scheme = 'sip';
      if (transport === 'tls' && this.use_sips_scheme) scheme = 'sips';

      let publicAddress = srf.locals.sbcPublicIpAddress.udp;
      if (transport !== 'udp') {
        if (srf.locals.sbcPublicIpAddress[transport]) {
          publicAddress = srf.locals.sbcPublicIpAddress[transport];
        }
        else if (transport === 'tls') {
          publicAddress = srf.locals.sbcPublicIpAddress.udp;
        }
      }

      let contactAddress = this.aor;
      if (this.use_public_ip_in_contact) {
        contactAddress = `${this.fromUser}@${publicAddress}`;
      }
      else if (this.account_sip_realm) {
        contactAddress = `${this.fromUser}@${this.account_sip_realm}`;
      }
      else if (localSIPDomain) {
        contactAddress = `${this.fromUser}@${localSIPDomain}`;
      }

      this.logger.debug(`sending REGISTER for ${this.aor}`);

      let proxy;
      if (this.outbound_sip_proxy) {
        proxy = `sip:${this.outbound_sip_proxy};transport=${transport}`;
        this.logger.debug(`sending via proxy ${proxy}`);
      } else {
        proxy = `sip:${this.ipv4}:${this.port};transport=${transport}`;
        this.logger.debug(`sending to registrar ${proxy}`);
      }
      const req = await srf.request(`${scheme}:${this.sip_realm}`, {
        method: 'REGISTER',
        proxy,
        headers: {
          'From': this.from,
          'To': this.from,
          'Contact': `<${scheme}:${contactAddress};transport=${transport}>;expires=${DEFAULT_EXPIRES}`,
          'Expires': DEFAULT_EXPIRES,
          'User-Agent': useragent
        },
        auth: {
          username: this.username,
          password: this.password
        }
      });
      req.on('response', async(res) => {
        let expires;
        if (res.status !== 200) {
          this.status = 'fail';
          this.logger.info(`${this.aor}: got ${res.status} registering to ${this.ipv4}:${this.port}`);
          this.timer = setTimeout(this.register.bind(this, srf), 30 * 1000);
          if (REGISTER_RESPONSE_REMOVE.includes(res.status)) {
            const { updateCarrierBySid, lookupCarrierBySid } = srf.locals.dbHelpers;
            await updateCarrierBySid(this.voip_carrier_sid, {requires_register: false});
            this.stop(srf); //Remove the retry timer
            const carrier = await lookupCarrierBySid(this.voip_carrier_sid);
            if (carrier) {
              // eslint-disable-next-line max-len
              this.logger.info(`Disabling Outbound Registration for carrier ${carrier.name} (sid:${carrier.voip_carrier_sid})`);
              writeAlerts({
                account_sid: carrier.account_sid,
                service_provider_sid: carrier.service_provider_sid,
                message: `Disabling Outbound Registration for carrier ${carrier.name} (sid:${carrier.voip_carrier_sid})`
              });
            }
          }
          expires = 0;
        }
        else {
          // the code parses the SIP headers to get the expires value
          // if there is a Contact header, it will use the expires value from there
          // otherwise, it will use the Expires header, acording to the SIP RFC 3261, section 10.2.4 Refreshing Bindings
          this.status = 'registered';
          expires = DEFAULT_EXPIRES;

          if (res.has('Expires')) {
            expires = parseInt(res.get('Expires'));
            this.logger.debug(`Using Expires header value of ${expires}`);
          }

          if (res.has('Contact')) {
            const contact = res.getParsedHeader('Contact');
            if (contact.length > 0 && contact[0].params && contact[0].params.expires) {
              expires = parseInt(contact[0].params.expires);
            }
          } else {
            this.logger.debug({ aor: this.aor, ipv4: this.ipv4, port: this.port },
              'no Contact header in 200 OK');
          }

          if (isNaN(expires) || expires < MIN_EXPIRES) {
            this.logger.debug({ aor: this.aor, ipv4: this.ipv4, port: this.port },
              `got expires of ${expires} in 200 OK, too small so setting to ${MIN_EXPIRES}`);
            expires = MIN_EXPIRES;
          }
          this.logger.debug(`setting timer for next register to ${expires} seconds`);
          this.timer = setTimeout(this.register.bind(this, srf), (expires / 2) * 1000);
        }
        const timestamp = new Date().toISOString();

        //update registration status for the carrier in the database
        updateVoipCarriersRegisterStatus(this.voip_carrier_sid, JSON.stringify({
          status: res.status === 200 ? 'ok' : 'fail',
          reason: `${res.status} ${res.reason}`,
          cseq: req.get('Cseq'),
          callId: req.get('Call-Id'),
          timestamp: timestamp,
          expires: expires
        }));

        // for reg trunks, create ephemeral set of IP addresses for inbound gateways
        if (this.trunk_type === 'reg') {
          this.addresses = [];
          if (this.port) {
            const addrs = await dnsResolverA(this.logger, this.sip_realm);
            this.addresses.push(...addrs);
          }
          else {
            const addrs = await dnsResolverSrv(this.logger, this.sip_realm, this.transport);
            this.addresses.push(...addrs);
          }

          if (this.addresses.length) {
            try {
              await Promise.all(
                this.addresses.map((ip) => createEphemeralGateway(ip, this.voip_carrier_sid, expires))
              );
            } catch (err) {
              this.logger.error({addresses: this.addresses, err}, 'Error creating hash for reg-gateway');
            }
            this.logger.debug({addresses: this.addresses},
              `Created ephemeral gateways for registration trunk ${this.voip_carrier_sid}, ${this.sip_realm}`);
          }
        }
      });
    } catch (err) {
      this.logger.error({ err }, `${this.aor}: Error registering to ${this.ipv4}:${this.port}`);
      this.timer = setTimeout(this.register.bind(this, srf), 60 * 1000);
      updateVoipCarriersRegisterStatus(this.voip_carrier_sid, JSON.stringify({
        status: 'fail',
        reason: err
      }));
    }

  }
}

const dnsResolverA = async(logger, hostname) => {
  try {
    const addresses = await dns.resolve4(hostname);
    logger.debug({addresses}, `Regbot: resolved ${hostname} into ${addresses.length} IPs`);
    return addresses;
  } catch (err) {
    logger.info({err}, `Error resolving ${hostname}`);
  }
  return [];
};

const dnsResolverSrv = async(logger, hostname, transport) => {
  let name;
  switch (transport) {
    case 'tls':
      name = `_sips._tcp.${hostname}`;
      break;
    case 'tcp':
      name = `_sip._tcp.${hostname}`;
      break;
    default:
      name = `_sip._udp.${hostname}`;
  }

  try {
    const arr = await dns.resolveSrv(name);
    logger.debug({arr}, `Regbot: resolved ${hostname}/${transport} into ${arr.length} results`);
    const ips = await Promise.all(
      arr.map((obj) => dnsResolverA(logger, obj.name))
    );
    return ips.flat();
  }
  catch (err) {
    logger.info({err}, `SRV Error resolving ${hostname}`);
  }
  return [];
};


module.exports = Regbot;

