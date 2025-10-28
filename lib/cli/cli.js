#!/usr/bin/env node

const net = require('net');

const SOCKET_PATH = process.env.SBC_SOCKET_PATH || '/tmp/sbc-sip-sidecar.sock';

function sendCommand(action, key, value, item, server) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET_PATH);

    socket.on('connect', () => {
      const cmd = { action };
      if (key) cmd.key = key;
      if (value) cmd.value = value;
      if (item) cmd.item = item;
      if (server) cmd.server = server;

      socket.write(JSON.stringify(cmd) + '\n');
    });

    socket.on('data', (data) => {
      try {
        const response = JSON.parse(data.toString().trim());
        socket.end();
        resolve(response);
      } catch {
        socket.end();
        reject(new Error('Invalid response'));
      }
    });

    socket.on('error', reject);
    socket.on('timeout', () => {
      socket.end();
      reject(new Error('Timeout'));
    });

    socket.setTimeout(5000);
  });
}

async function handleFeatureServerCommand(args) {
  const cmd = args[0];

  switch (cmd) {
    case 'drain':
      if (!args[1]) {
        console.error('Error: drain requires server IP address');
        process.exit(1);
      }
      const drainResult = await sendCommand('fs-drain', null, null, null, args[1]);
      if (drainResult.error || !drainResult.success) {
        console.error('Error:', drainResult.error || 'Failed to drain server');
        process.exit(1);
      }
      console.log(`✓ Drained ${drainResult.server}`);
      console.log(`Drained: [${drainResult.drained.join(', ')}]`);
      break;

    case 'undrain':
      if (!args[1]) {
        console.error('Error: undrain requires server IP address');
        process.exit(1);
      }
      const undrainResult = await sendCommand('fs-undrain', null, null, null, args[1]);
      if (undrainResult.error || !undrainResult.success) {
        console.error('Error:', undrainResult.error || 'Failed to undrain server');
        process.exit(1);
      }
      console.log(`✓ Undrained ${undrainResult.server}`);
      console.log(`Drained: [${undrainResult.drained.join(', ')}]`);
      break;

    case 'drained':
      const drained = await sendCommand('fs-drained');
      if (drained.error) {
        console.error('Error:', drained.error);
        process.exit(1);
      }
      if (drained.drained.length === 0) {
        console.log('No servers drained');
      } else {
        console.log('Drained servers:');
        drained.drained.forEach((s) => console.log(`  - ${s}`));
      }
      break;

    case 'active':
      const active = await sendCommand('fs-available');
      if (active.error || !active.success) {
        console.error('Error:', active.error || 'Failed to get active servers');
        process.exit(1);
      }
      if (active.available.length === 0) {
        console.log('No active feature servers found');
      } else {
        console.log('Available feature servers:');
        active.available.forEach((s) => console.log(`  🟢 ${s}`));
      }
      break;

    case 'list':
      const list = await sendCommand('fs-list');
      if (list.error) {
        console.error('Error:', list.error);
        process.exit(1);
      }
      if (list.servers.length === 0) {
        console.log('No servers configured');
        if (list.drained.length > 0) {
          console.log('Orphaned drained servers:');
          list.drained.forEach((s) => console.log(`  - ${s} (orphaned)`));
        }
      } else {
        console.log('Servers:');
        list.servers.forEach(({ server, status }) => {
          const icon = status === 'drained' ? '🔴' : '🟢';
          console.log(`  ${icon} ${server} (${status})`);
        });
      }
      break;

    default:
      console.error('Unknown command:', cmd);
      console.error('Use: drain, undrain, drained, active, list');
      process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('SBC CLI');
    console.log('Usage:');
    console.log('  sbc-cli fs drain <ip>        Drain server by IP');
    console.log('  sbc-cli fs undrain <ip>      Undrain server by IP');
    console.log('  sbc-cli fs drained           List drained server IPs');
    console.log('  sbc-cli fs active            List active/available servers');
    console.log('  sbc-cli fs list              List all servers with status');
    console.log('  sbc-cli set <key> <value>    Set config');
    console.log('  sbc-cli get <key>            Get config');
    console.log('  sbc-cli list                 List all config');
    console.log('');
    console.log('Examples:');
    console.log('  sbc-cli fs drain 192.168.1.10');
    console.log('  sbc-cli fs undrain 192.168.1.10');
    console.log('  sbc-cli fs drained');
    console.log('  sbc-cli fs active');
    return;
  }

  const cmd = args[0];

  try {
    switch (cmd) {
      case 'fs':
        if (args.length < 2) {
          console.error('fs needs: drain, undrain, drained, active, or list');
          process.exit(1);
        }
        await handleFeatureServerCommand(args.slice(1));
        break;

      case 'set':
        if (args.length < 3) {
          console.error('set needs key and value');
          process.exit(1);
        }
        const setResult = await sendCommand('set', args[1], args[2]);
        if (setResult.error) {
          console.error('Error:', setResult.error);
          process.exit(1);
        }
        console.log(`✓ ${setResult.key} = ${JSON.stringify(setResult.value)}`);
        break;

      case 'get':
        if (args.length < 2) {
          console.error('get needs key');
          process.exit(1);
        }
        const getResult = await sendCommand('get', args[1]);
        if (getResult.error) {
          console.error('Error:', getResult.error);
          process.exit(1);
        }
        console.log(`${getResult.key} = ${JSON.stringify(getResult.value)}`);
        break;

      case 'list':
        const listResult = await sendCommand('list');
        if (listResult.error) {
          console.error('Error:', listResult.error);
          process.exit(1);
        }
        console.log('Config:');
        for (const [key, value] of Object.entries(listResult.config)) {
          console.log(`  ${key} = ${JSON.stringify(value)}`);
        }
        break;

      default:
        console.error('Unknown command:', cmd);
        process.exit(1);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
