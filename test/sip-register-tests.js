const test = require('tape');
const { output, sippUac } = require('./sipp')('test_sbc-sip-sidecar');
const debug = require('debug')('drachtio:sbc-sip-sidecar');
const clearModule = require('clear-module');

process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
});

function connect(connectable) {
  return new Promise((resolve, reject) => {
    connectable.on('connect', () => {
      return resolve();
    });
  });
}

test('register tests', (t) => {
  clearModule.all();
  const {srf} = require('../app');

  const sippRegObj = {
    remote_host: '172.38.0.10:5060'
  };

  connect(srf)
    .then(() => {
      sippRegObj.data_file = 'bad_realm.csv';
      return sippUac('uac-reject-ipv4-realm.xml', sippRegObj);
    })
    .then(() => {
      t.pass('received immediate 403 Forbidden when using ipv4 dot decimal for sip realm');
      sippRegObj.data_file = 'bad_password.csv';
      return sippUac('uac-register-auth-failure-expect-403.xml', sippRegObj);
    })
    .then(() => {
      t.pass('received 403 Forbidden after challenge when using invalid credentials');
      sippRegObj.data_file = 'good_user.csv';
      return sippUac('uac-register-auth-success.xml', sippRegObj);
    })
    .then(() => {
      t.pass('successfully registered when using valid credentials (service provider level auth hook)');
      return sippUac('uac-re-register-auth-success.xml', sippRegObj);
    })
    .then(() => {
      t.pass('successfully re-registered against cached registration');
      sippRegObj.data_file = 'good_user2.csv';
      return sippUac('uac-register-auth-success-jane.xml', sippRegObj);
    })
    .then(() => {
      t.pass('successfully registered against short expiry');
      return sippUac('uac-register-auth-success-jane.xml', sippRegObj);
    })
    .then(() => {
      t.pass('successfully re-registered against short registration with re-auth');
      if (srf.locals.lb) srf.locals.lb.disconnect();
      srf.disconnect();
      t.end();
      return;
    })
    .catch((err) => {
      if (srf.locals.lb) srf.locals.lb.disconnect();
      if (srf) srf.disconnect();
      console.log(`error received: ${err}`);
      t.error(err);
    });
});
