const test = require('tape');
const exec = require('child_process').exec ;
const fs = require('fs');

test('creating self-signed tls certificate for the testbed..', (t) => {
  const dir = `${__dirname}/tls`;
  if (fs.existsSync(`${dir}/server.crt`)) return t.end();
  fs.mkdirSync(dir, {recursive: true});
  exec(`openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=sbc.test" \
    -keyout ${dir}/server.key -out ${dir}/server.crt`, (err) => {
    t.pass('tls certificate created');
    t.end(err);
  });
});

test('starting docker network..', (t) => {
  exec(`docker-compose -f ${__dirname}/docker-compose-testbed.yaml up -d`, (err, stdout, stderr) => {
    t.pass('docker started');
    t.end(err);  
  });
});

  
