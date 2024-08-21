const test = require('tape');
const clearModule = require('clear-module');
const { isIPv4 } = require('../lib/utils');

process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
});

const testData = [
	{ input: "192.168.1.1", expectedOutput: true, description: "Valid IPv4 address" },
	{ input: "10.0.0.1", expectedOutput: true, description: "Valid IPv4 address" },
	{ input: "255.255.255.255", expectedOutput: true, description: "Valid IPv4 address (broadcast)" },
	{ input: "0.0.0.0", expectedOutput: true, description: "Valid IPv4 address (unspecified)" },
	{ input: "127.0.0.1", expectedOutput: true, description: "Valid IPv4 address (localhost)" },
	{ input: "1.2.3.4", expectedOutput: true, description: "Valid IPv4 address" },
	{ input: "192.168.0.255", expectedOutput: true, description: "Valid IPv4 address" },
	{ input: "255.0.0.0", expectedOutput: true, description: "Valid IPv4 address" },
	{ input: "", expectedOutput: false, description: "Empty string" },
	{ input: "192.168.1", expectedOutput: false, description: "Missing octet" },
	{ input: "192.168.1.256", expectedOutput: false, description: "Octet out of range" },
	{ input: "192.168.1.2.3", expectedOutput: false, description: "Too many octets" },
	{ input: "192.168.a.1", expectedOutput: false, description: "Non-numeric character" },
	{ input: "192..1.1", expectedOutput: false, description: "Consecutive dots" },
	{ input: ".192.168.1.1", expectedOutput: false, description: "Leading dot" },
	{ input: "192.168.1.1.", expectedOutput: false, description: "Trailing dot" },
	{ input: " 192.168.1.1 ", expectedOutput: false, description: "Leading/trailing spaces" },
	{ input: "192,168,1,1", expectedOutput: false, description: "Commas instead of dots" },
	{ input: "2001:0db8:85a3:0000:0000:8a2e:0370:7334", expectedOutput: false, description: "IPv6 address" },
	{ input: "localhost", expectedOutput: false, description: "Hostname, not IP" },
	{ input: "10.0.0.1/24", expectedOutput: false, description: "IPv4 with subnet mask" },
	{ input: "551140451046.primary.companyflex.de:0", expectedOutput: false, description: "Hostname with port, not IP" },
  ];

test('register tests', (t) => {
  clearModule.all();

  for (const data of testData) {
	t.equal(isIPv4(data.input), data.expectedOutput, data.description);
  }

  t.end();
});
