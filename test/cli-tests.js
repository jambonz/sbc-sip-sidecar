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
}, { level: JAMBONES_LOGLEVEL || 'info' });
const logger = require('pino')(opts);
const {
  addToSet,
  removeFromSet,
  retrieveSet
} = require('@jambonz/realtimedb-helpers')({
  host: JAMBONES_REDIS_HOST || 'localhost',
  port: JAMBONES_REDIS_PORT || 6379
}, logger);

const { isValidIP } = require('../lib/cli/feature-server-config');

const activeSetName = `${(JAMBONES_CLUSTER_ID || 'default')}:active-fs`;
const drainedSetName = `${(JAMBONES_CLUSTER_ID || 'default')}:drained-fs`;

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

function runCli(command) {
  return new Promise((resolve, reject) => {
    exec(`npm run cli ${command}`, { cwd: __dirname + '/..' }, (err, stdout, stderr) => {
      if (err) {
        return reject({ err, stderr, stdout });
      }
      resolve({ stdout, stderr });
    });
  });
}

// Setup test data
test('setup feature server test data', async (t) => {
  try {
    // Clear any existing test data
    const existing = await retrieveSet(drainedSetName);
    if (existing && existing.length > 0) {
      for (const server of existing) {
        await removeFromSet(drainedSetName, server);
      }
    }

    // Add some test feature servers to active set
    await addToSet(activeSetName, '192.168.1.10');
    await addToSet(activeSetName, '192.168.1.11');
    await addToSet(activeSetName, '192.168.1.12');
    
    // Add one server to drained set initially
    await addToSet(drainedSetName, '192.168.1.11');
    
    t.pass('test data setup complete');
    t.end();
  } catch (err) {
    t.fail(`Failed to setup test data: ${err.message}`);
    t.end();
  }
});

test('CLI integration tests', (t) => {
  clearModule.all();
  const { srf } = require('../app');
  t.timeoutAfter(30000);

  connect(srf)
    .then(() => wait(1000)) // Wait for CLI server to start
    .then(async () => {
      // Test CLI help
      const helpResult = await runCli('');
      t.ok(helpResult.stdout.includes('SBC Runtime CLI'), 'CLI help displays correctly');
      t.pass('CLI help command works');

      // Test fs active command
      const activeResult = await runCli('fs active');
      t.ok(activeResult.stdout.includes('Available feature servers'), 'fs active shows header');
      t.ok(activeResult.stdout.includes('192.168.1.10'), 'fs active shows test server');
      t.pass('fs active command works');

      // Test fs drained command
      const drainedResult = await runCli('fs drained');
      t.ok(drainedResult.stdout.includes('192.168.1.11'), 'fs drained shows initially drained server');
      t.pass('fs drained command works');

      // Test drain a server
      const drainResult = await runCli('fs drain 192.168.1.10');
      t.ok(drainResult.stdout.includes('✓ Drained 192.168.1.10'), 'drain command shows success');
      t.pass('fs drain command works');

      // Verify server is drained
      const drainedAfterResult = await runCli('fs drained');
      t.ok(drainedAfterResult.stdout.includes('192.168.1.10'), 'drained server appears in list');
      t.pass('drained server verification works');

      // Test undrain a server
      const undrainResult = await runCli('fs undrain 192.168.1.10');
      t.ok(undrainResult.stdout.includes('✓ Undrained 192.168.1.10'), 'undrain command shows success');
      t.pass('fs undrain command works');

      // Test fs list command
      const listResult = await runCli('fs list');
      t.ok(listResult.stdout.includes('Feature servers'), 'fs list shows header');
      t.ok(listResult.stdout.includes('192.168.1.10'), 'fs list shows servers');
      t.pass('fs list command works');

      return Promise.resolve();
    })
    .then(() => {
      if (srf) srf.disconnect();
      t.end();
    })
    .catch((err) => {
      console.log('CLI test error:', err);
      if (srf) srf.disconnect();
      t.fail(`CLI test failed: ${err.err ? err.err.message : err.message}`);
      if (err.stderr) console.log('stderr:', err.stderr);
      if (err.stdout) console.log('stdout:', err.stdout);
      t.end();
    });
});

test('CLI error handling', (t) => {
  clearModule.all();
  const { srf } = require('../app');
  t.timeoutAfter(15000);

  connect(srf)
    .then(() => wait(500))
    .then(async () => {
      // Test invalid IP for drain
      try {
        await runCli('fs drain invalid-ip');
        t.fail('drain with invalid IP should fail');
      } catch (err) {
        t.ok(err.stderr.includes('Invalid IP') || err.stdout.includes('Invalid IP'), 'drain rejects invalid IP');
        t.pass('invalid IP validation works');
      }

      // Test unknown command
      try {
        await runCli('unknown-command');
        t.fail('unknown command should fail');
      } catch (err) {
        t.ok(err.stderr.includes('Unknown command') || err.stdout.includes('Unknown command'), 'unknown command rejected');
        t.pass('unknown command handling works');
      }

      // Test missing server argument for drain
      try {
        await runCli('fs drain');
        t.fail('drain without server should fail');
      } catch (err) {
        t.ok(err.stderr.includes('requires server') || err.stdout.includes('requires server'), 'drain requires server argument');
        t.pass('missing argument validation works');
      }

      return Promise.resolve();
    })
    .then(() => {
      if (srf) srf.disconnect();
      t.end();
    })
    .catch((err) => {
      console.log('CLI error test error:', err);
      if (srf) srf.disconnect();
      t.fail(`CLI error test failed: ${err.message}`);
      t.end();
    });
});

test('CLI config commands', (t) => {
  clearModule.all();
  const { srf } = require('../app');
  t.timeoutAfter(15000);

  connect(srf)
    .then(() => wait(500))
    .then(async () => {
      // Test set command
      const setResult = await runCli('set testKey testValue');
      t.ok(setResult.stdout.includes('testKey = "testValue"'), 'set command works');
      t.pass('CLI set command works');

      // Test get command
      const getResult = await runCli('get testKey');
      t.ok(getResult.stdout.includes('testKey = "testValue"'), 'get command returns correct value');
      t.pass('CLI get command works');

      // Test list command
      const listResult = await runCli('list');
      t.ok(listResult.stdout.includes('Runtime Configuration'), 'list command shows header');
      t.ok(listResult.stdout.includes('testKey'), 'list command shows set values');
      t.pass('CLI list command works');

      return Promise.resolve();
    })
    .then(() => {
      if (srf) srf.disconnect();
      t.end();
    })
    .catch((err) => {
      console.log('CLI config test error:', err);
      if (srf) srf.disconnect();
      t.fail(`CLI config test failed: ${err.err ? err.err.message : err.message}`);
      if (err.stderr) console.log('stderr:', err.stderr);
      if (err.stdout) console.log('stdout:', err.stdout);
      t.end();
    });
});

// Cleanup test data
test('cleanup feature server test data', async (t) => {
  try {
    // Clean up test data
    const drainedServers = await retrieveSet(drainedSetName);
    if (drainedServers && drainedServers.length > 0) {
      for (const server of drainedServers) {
        await removeFromSet(drainedSetName, server);
      }
    }

    const activeServers = await retrieveSet(activeSetName);
    if (activeServers && activeServers.length > 0) {
      for (const server of ['192.168.1.10', '192.168.1.11', '192.168.1.12']) {
        await removeFromSet(activeSetName, server);
      }
    }
    
    t.pass('test data cleanup complete');
    t.end();
  } catch (err) {
    t.fail(`Failed to cleanup test data: ${err.message}`);
    t.end();
  }
});

test('IP validation tests', (t) => {
  // Valid IPv4
  t.ok(isValidIP('192.168.1.1'), 'valid IPv4 passes');
  t.ok(isValidIP('10.0.0.1'), 'valid private IPv4 passes');
  t.ok(isValidIP('255.255.255.255'), 'max IPv4 passes');

  // Invalid IPv4
  t.notOk(isValidIP('256.1.1.1'), 'invalid IPv4 fails');
  t.notOk(isValidIP('192.168.1'), 'incomplete IPv4 fails');
  t.notOk(isValidIP(''), 'empty string fails');
  t.notOk(isValidIP(null), 'null fails');
  t.notOk(isValidIP(undefined), 'undefined fails');
  t.notOk(isValidIP('not-an-ip'), 'random string fails');

  // Valid IPv6
  t.ok(isValidIP('::1'), 'IPv6 loopback passes');
  t.ok(isValidIP('2001:0db8:85a3:0000:0000:8a2e:0370:7334'), 'full IPv6 passes');

  t.end();
});

test('Feature Server Config utility functions', (t) => {
  clearModule.all();
  const { srf } = require('../app');
  t.timeoutAfter(30000);

  connect(srf)
    .then(() => wait(1000)) // Wait for CLI and Redis initialization
    .then(async () => {
      // Set up test data first
      await addToSet(activeSetName, '192.168.1.10');
      await addToSet(activeSetName, '192.168.1.11');
      await addToSet(activeSetName, '192.168.1.12');
      await addToSet(drainedSetName, '192.168.1.11');

      const {
        isDrained,
        getDrainedServers,
        getActiveServers,
        getAvailableServers,
        getAllServersWithStatus
      } = require('../lib/cli/feature-server-config');

      // Test initial state
      let drainedList = await getDrainedServers();
      t.ok(Array.isArray(drainedList), 'getDrainedServers returns array');
      t.ok(drainedList.includes('192.168.1.11'), 'initially contains test drained server');
      t.pass('getDrainedServers works correctly');

      let activeList = await getActiveServers();
      t.ok(Array.isArray(activeList), 'getActiveServers returns array');
      t.ok(activeList.includes('192.168.1.10'), 'contains test active server');
      t.ok(activeList.includes('192.168.1.12'), 'contains test active server');
      t.pass('getActiveServers works correctly');

      // Test isDrained function
      let drained1 = await isDrained('192.168.1.11');
      let drained2 = await isDrained('192.168.1.10');
      let drainedInvalid = await isDrained('invalid-ip');
      t.ok(drained1, 'isDrained correctly identifies drained server');
      t.notOk(drained2, 'isDrained correctly identifies non-drained server');
      t.notOk(drainedInvalid, 'isDrained returns false for invalid IP');
      t.pass('isDrained works correctly');

      // Test getAvailableServers (active servers that are not drained)
      let availableList = await getAvailableServers();
      t.ok(Array.isArray(availableList), 'getAvailableServers returns array');
      t.ok(availableList.includes('192.168.1.10'), 'includes active non-drained server');
      t.ok(availableList.includes('192.168.1.12'), 'includes active non-drained server');
      t.notOk(availableList.includes('192.168.1.11'), 'excludes drained server');
      t.pass('getAvailableServers works correctly');

      // Test getAllServersWithStatus
      let statusResult = await getAllServersWithStatus();
      t.ok(statusResult && typeof statusResult === 'object', 'getAllServersWithStatus returns object');
      t.ok(Array.isArray(statusResult.servers), 'result has servers array');
      t.ok(Array.isArray(statusResult.drained), 'result has drained array');
      
      const server10 = statusResult.servers.find(s => s.server === '192.168.1.10');
      const server11 = statusResult.servers.find(s => s.server === '192.168.1.11');
      const server12 = statusResult.servers.find(s => s.server === '192.168.1.12');
      
      t.ok(server10 && server10.status === 'active', 'server 10 has active status');
      t.ok(server11 && server11.status === 'drained', 'server 11 has drained status');
      t.ok(server12 && server12.status === 'active', 'server 12 has active status');
      t.pass('getAllServersWithStatus works correctly');

      // Now test after draining a server via CLI
      await runCli('fs drain 192.168.1.10');

      // Re-test functions after draining
      drainedList = await getDrainedServers();
      t.ok(drainedList.includes('192.168.1.10'), 'getDrainedServers includes newly drained server');
      t.ok(drainedList.includes('192.168.1.11'), 'getDrainedServers still includes previously drained server');
      
      drained1 = await isDrained('192.168.1.10');
      drained2 = await isDrained('192.168.1.12');
      t.ok(drained1, 'isDrained correctly identifies newly drained server');
      t.notOk(drained2, 'isDrained correctly identifies still active server');

      availableList = await getAvailableServers();
      t.notOk(availableList.includes('192.168.1.10'), 'getAvailableServers excludes newly drained server');
      t.notOk(availableList.includes('192.168.1.11'), 'getAvailableServers excludes previously drained server');
      t.ok(availableList.includes('192.168.1.12'), 'getAvailableServers includes remaining active server');

      statusResult = await getAllServersWithStatus();
      const updatedServer10 = statusResult.servers.find(s => s.server === '192.168.1.10');
      const updatedServer12 = statusResult.servers.find(s => s.server === '192.168.1.12');
      t.ok(updatedServer10 && updatedServer10.status === 'drained', 'server 10 now has drained status');
      t.ok(updatedServer12 && updatedServer12.status === 'active', 'server 12 still has active status');

      // Test undraining
      await runCli('fs undrain 192.168.1.10');

      drained1 = await isDrained('192.168.1.10');
      t.notOk(drained1, 'isDrained correctly identifies undrained server');

      availableList = await getAvailableServers();
      t.ok(availableList.includes('192.168.1.10'), 'getAvailableServers includes undrained server');

      // Clean up test data
      await removeFromSet(drainedSetName, '192.168.1.10');
      await removeFromSet(drainedSetName, '192.168.1.11');
      await removeFromSet(activeSetName, '192.168.1.10');
      await removeFromSet(activeSetName, '192.168.1.11');
      await removeFromSet(activeSetName, '192.168.1.12');

      t.pass('All feature server config utility functions tested successfully');
      return Promise.resolve();
    })
    .then(() => {
      if (srf) srf.disconnect();
      t.end();
    })
    .catch((err) => {
      console.log('Feature server config test error:', err);
      if (srf) srf.disconnect();
      t.fail(`Feature server config test failed: ${err.message}`);
      t.end();
    });
});

test('Feature Server Config edge cases and error handling', (t) => {
  clearModule.all();
  
  // Test functions when runtime config is not initialized (Redis not available)
  const {
    isDrained,
    getDrainedServers,
    getActiveServers,
    getAvailableServers,
    getAllServersWithStatus
  } = require('../lib/cli/feature-server-config');

  // These should return safe defaults when Redis is not available
  Promise.all([
    isDrained('192.168.1.1'),
    getDrainedServers(),
    getActiveServers(),
    getAvailableServers(),
    getAllServersWithStatus()
  ]).then(([
    drainedResult,
    drainedList,
    activeList,
    availableList,
    statusResult
  ]) => {
    // Should return safe defaults when Redis is not available
    t.equal(drainedResult, false, 'isDrained returns false when Redis unavailable');
    t.ok(Array.isArray(drainedList) && drainedList.length === 0, 'getDrainedServers returns empty array when Redis unavailable');
    t.ok(Array.isArray(activeList) && activeList.length === 0, 'getActiveServers returns empty array when Redis unavailable');
    t.ok(Array.isArray(availableList) && availableList.length === 0, 'getAvailableServers returns empty array when Redis unavailable');
    t.ok(statusResult && Array.isArray(statusResult.servers) && statusResult.servers.length === 0, 'getAllServersWithStatus returns empty result when Redis unavailable');
    t.ok(statusResult && Array.isArray(statusResult.drained) && statusResult.drained.length === 0, 'getAllServersWithStatus drained array is empty when Redis unavailable');

    t.pass('All edge cases handled gracefully');
    t.end();
  }).catch((err) => {
    t.fail(`Edge case test failed: ${err.message}`);
    t.end();
  });
});