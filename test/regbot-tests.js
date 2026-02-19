const test = require('tape');
const {
  JAMBONES_REDIS_HOST,
  JAMBONES_REDIS_PORT,
  JAMBONES_LOGLEVEL,
  JAMBONES_CLUSTER_ID,
} = require('../lib/config');
const clearModule = require('clear-module');
const exec = require('child_process').exec;
const opts = Object.assign({
  timestamp: () => { return `, "time": "${new Date().toISOString()}"`; }
}, { level:JAMBONES_LOGLEVEL || 'info' });
const logger = require('pino')(opts);
const {
  addToSet,
  removeFromSet } = require('@jambonz/realtimedb-helpers')({
    host: JAMBONES_REDIS_HOST || 'localhost',
    port: JAMBONES_REDIS_PORT || 6379
  }, logger);
const setName = `${(JAMBONES_CLUSTER_ID || 'default')}:active-sip`;

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

const wait = (duration) => {
  return new Promise((resolve) => {
    setTimeout(resolve, duration);
  });
};

test('populating more test case data', (t) => {
  exec(`mysql -h 127.0.0.1 -u root --protocol=tcp -D jambones_test < ${__dirname}/db/populate-test-data2.sql`, (err, stdout, stderr) => {
    if (err) return t.end(err);
    t.pass('test data set created');
    t.end();
  });
});

test('trunk register tests', (t) => {
  clearModule.all();
  const { srf } = require('../app');
  t.timeoutAfter(180000);

  console.log('waiting 15 seconds for regbot to start up');
  connect(srf)
    .then(wait.bind(null, 15000))
    .then(() => {
      const obj = srf.locals.regbotStatus();
      return t.ok(obj.total === 1 && obj.registered === 1, 'initial regbot running and successfully registered to trunk');
    })
    .then(() => {
      return new Promise((resolve, reject) => {
        exec(`mysql -h 127.0.0.1 -u root --protocol=tcp   -D jambones_test < ${__dirname}/db/populate-test-data3.sql`, (err, stdout, stderr) => {
          if (err) return reject(err);
          t.pass('added new gateway');
          resolve();
        });
      });
    })
    .then(() => {
      console.log('waiting 65 seconds for regbot to come around to check for new gateways');
      return wait(65000);
    })
    .then(() => {
      const obj = srf.locals.regbotStatus();
      console.log(`regbotStatus: total=${obj.total}, registered=${obj.registered}, active=${obj.active}`);
      return t.ok(obj.total === 2, 'successfully added gateway that tests failure result');
    })
    .then(() => {
      return new Promise((resolve, reject) => {
        exec(`mysql -h 127.0.0.1 -u root --protocol=tcp   -D jambones_test < ${__dirname}/db/populate-test-data4.sql`, (err, stdout, stderr) => {
          if (err) return reject(err);
          t.pass('added new reg trunk');
          resolve();
        });
      });
    })
    .then(() => {
      console.log('waiting 65 seconds for regbot to come around to check for new reg trunk');
      return wait(65000);
    })
    .then(() => {
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

/*
test('trunk register tests when its IP in redis cache', (t) => {
  clearModule.all();
  const { srf } = require('../app');
  t.timeoutAfter(90000);
  addToSet(setName, "172.39.0.10:5060");

  connect(srf)
    .then(wait.bind(null, 1500))
    .then(() => {
      const obj = srf.locals.regbotStatus();
      return t.ok(obj.total === 1 && obj.registered === 1, 'initial regbot running and successfully registered to trunk');
    })
    .then(() => {
      if (srf.locals.lb) srf.locals.lb.disconnect();
      srf.disconnect();
      t.end();
      removeFromSet(setName, "172.39.0.10:5060");
      return;
    })
    .catch((err) => {
      if (srf.locals.lb) srf.locals.lb.disconnect();

      if (srf) srf.disconnect();
      removeFromSet(setName, "172.39.0.10:5060");
      console.log(`error received: ${err}`);
      t.error(err);
    });
});

test('trunk register with sbc public IP address', (t) => {
  clearModule.all();
  const { srf } = require('../app');
  t.timeoutAfter(60000);
  JAMBONES_REGBOT_CONTACT_USE_IP = true;
  addToSet(setName, "172.39.0.10:5060");

  connect(srf)
    .then(wait.bind(null, 1500))
    .then(() => {
      const obj = srf.locals.regbotStatus();
      return t.ok(obj.total === 1 && obj.registered === 1, 'initial regbot running and successfully registered to trunk');
    })
    .then(() => {
      if (srf.locals.lb) srf.locals.lb.disconnect();
      srf.disconnect();
      t.end();
      removeFromSet(setName, "172.39.0.10:5060");
      return;
    })
    .catch((err) => {
      if (srf.locals.lb) srf.locals.lb.disconnect();

      if (srf) srf.disconnect();
      removeFromSet(setName, "172.39.0.10:5060");
      console.log(`error received: ${err}`);
      t.error(err);
    });
});

test('trunk not register tests when its IP is not in redis cache', (t) => {
  clearModule.all();
  const { srf } = require('../app');
  t.timeoutAfter(60000);
  addToSet(setName, "172.39.0.11:5060")

  connect(srf)
    .then(wait.bind(null, 1500))
    .then(() => {
      return t.ok(!srf.locals.regbotStatus, 'No Regbot initiated');
    })
    .then(()=> {
      return removeFromSet(setName, "172.39.0.11:5060");
    })
    .then(() => {
      return addToSet(setName, "172.39.0.10:5060")
    })
    .then(() => {
      return wait(35000);
    })
    .then(()=> {
      const obj = srf.locals.regbotStatus();
      return t.ok(obj.total === 1 && obj.registered === 1, 'initial regbot running and successfully registered to trunk');
    })
    .then(() => {
      if (srf.locals.lb) srf.locals.lb.disconnect();
      srf.disconnect();
      t.end();
      removeFromSet(setName, "172.39.0.11:5060");
      return;
    })
    .catch((err) => {
      if (srf.locals.lb) srf.locals.lb.disconnect();

      if (srf) srf.disconnect();
      removeFromSet(setName, "172.39.0.11:5060");
      console.log(`error received: ${err}`);
      t.error(err);
    });
});
*/