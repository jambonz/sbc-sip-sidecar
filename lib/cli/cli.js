#!/usr/bin/env node

const net = require('net');

const SOCKET_PATH = process.env.SBC_SOCKET_PATH || '/tmp/sbc-sip-sidecar.sock';

function connectAndSend(command) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET_PATH);

    socket.on('connect', () => {
      socket.write(JSON.stringify(command) + '\n');
    });

    socket.on('data', (data) => {
      try {
        const response = JSON.parse(data.toString().trim());
        socket.end();
        resolve(response);
      } catch {
        socket.end();
        reject(new Error('Invalid response from server'));
      }
    });

    socket.on('error', (err) => {
      reject(new Error(`Connection failed: ${err.message}`));
    });

    socket.setTimeout(5000, () => {
      socket.end();
      reject(new Error('Command timed out'));
    });
  });
}

function exitWithError(message) {
  console.error('Error:', message);
  process.exit(1);
}

function validateArgs(args, minCount, usage) {
  if (args.length < minCount) {
    exitWithError(`${usage}`);
  }
}

async function handleFeatureServerCommand(args) {
  const [action, server] = args;

  switch (action) {
    case 'drain':
      validateArgs(args, 2, 'drain requires server IP address');
      const drainResult = await connectAndSend({ action: 'fs-drain', server });

      if (!drainResult.success) {
        exitWithError(drainResult.error || 'Failed to drain server');
      }

      console.log(`✓ Drained ${drainResult.server}`);
      console.log(`Drained servers: [${drainResult.drained.join(', ')}]`);
      break;

    case 'undrain':
      validateArgs(args, 2, 'undrain requires server IP address');
      const undrainResult = await connectAndSend({ action: 'fs-undrain', server });

      if (!undrainResult.success) {
        exitWithError(undrainResult.error || 'Failed to undrain server');
      }

      console.log(`✓ Undrained ${undrainResult.server}`);
      console.log(`Drained servers: [${undrainResult.drained.join(', ')}]`);
      break;

    case 'drained':
      const drainedResult = await connectAndSend({ action: 'fs-drained' });

      if (drainedResult.error) {
        exitWithError(drainedResult.error);
      }

      if (drainedResult.drained.length === 0) {
        console.log('No servers are currently drained');
      } else {
        console.log('Drained servers:');
        drainedResult.drained.forEach((server) => console.log(`  🔴 ${server}`));
      }
      break;

    case 'active':
      const activeResult = await connectAndSend({ action: 'fs-available' });

      if (!activeResult.success) {
        exitWithError(activeResult.error || 'Failed to get active servers');
      }

      if (activeResult.available.length === 0) {
        console.log('No active feature servers found');
      } else {
        console.log('Available feature servers:');
        activeResult.available.forEach((server) => console.log(`  🟢 ${server}`));
      }
      break;

    case 'list':
      const listResult = await connectAndSend({ action: 'fs-list' });

      if (listResult.error) {
        exitWithError(listResult.error);
      }

      if (listResult.servers.length === 0) {
        console.log('No servers configured');
        if (listResult.drained.length > 0) {
          console.log('Orphaned drained servers:');
          listResult.drained.forEach((server) => console.log(`  🔴 ${server} (orphaned)`));
        }
      } else {
        console.log('Feature servers:');
        listResult.servers.forEach(({ server, status }) => {
          const icon = status === 'drained' ? '🔴' : '🟢';
          console.log(`  ${icon} ${server} (${status})`);
        });
      }
      break;

    default:
      exitWithError(`Unknown fs command: ${action}. Use: drain, undrain, drained, active, list`);
  }
}

function showHelp() {
  console.log('SBC Runtime CLI');
  console.log('');
  console.log('Usage:');
  console.log('  npm run cli <command> [options]');
  console.log('');
  console.log('Feature Server Commands:');
  console.log('  npm run cli fs drain <ip>      Drain server (remove from pool)');
  console.log('  npm run cli fs undrain <ip>    Undrain server (add back to pool)');
  console.log('  npm run cli fs drained         Show drained servers');
  console.log('  npm run cli fs active          Show available servers');
  console.log('  npm run cli fs list            Show all servers with status');
  console.log('');
  console.log('Configuration Commands:');
  console.log('  npm run cli set <key> <value>  Set runtime config');
  console.log('  npm run cli get <key>          Get runtime config');
  console.log('  npm run cli list               Show all runtime config');
  console.log('');
  console.log('Examples:');
  console.log('  npm run cli fs drain 192.168.1.10');
  console.log('  npm run cli fs active');
}

async function handleConfigCommand(action, args) {
  switch (action) {
    case 'set':
      validateArgs(args, 2, 'set requires key and value');
      const [key, value] = args;
      const setResult = await connectAndSend({ action: 'set', key, value });

      if (setResult.error) {
        exitWithError(setResult.error);
      }

      console.log(`✓ ${setResult.key} = ${JSON.stringify(setResult.value)}`);
      break;

    case 'get':
      validateArgs(args, 1, 'get requires key');
      const getResult = await connectAndSend({ action: 'get', key: args[0] });

      if (getResult.error) {
        exitWithError(getResult.error);
      }

      console.log(`${getResult.key} = ${JSON.stringify(getResult.value)}`);
      break;

    case 'list':
      const listResult = await connectAndSend({ action: 'list' });

      if (listResult.error) {
        exitWithError(listResult.error);
      }

      console.log('Runtime Configuration:');
      const entries = Object.entries(listResult.config);
      if (entries.length === 0) {
        console.log('  (no configuration set)');
      } else {
        entries.forEach(([key, value]) => {
          console.log(`  ${key} = ${JSON.stringify(value)}`);
        });
      }
      break;

    default:
      exitWithError(`Unknown config command: ${action}. Use: set, get, list`);
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    showHelp();
    return;
  }

  const [command, ...remainingArgs] = args;

  try {
    switch (command) {
      case 'fs':
        validateArgs(remainingArgs, 1, 'fs command requires an action');
        await handleFeatureServerCommand(remainingArgs);
        break;

      case 'set':
      case 'get':
      case 'list':
        await handleConfigCommand(command, remainingArgs);
        break;

      default:
        exitWithError(`Unknown command: ${command}. Run without arguments for help.`);
    }
  } catch (error) {
    exitWithError(error.message);
  }
}

if (require.main === module) {
  main().catch((error) => {
    exitWithError(error.message);
  });
}
