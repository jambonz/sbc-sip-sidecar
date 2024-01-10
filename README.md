# sbc-sip-sidecar ![Build Status](https://github.com/jambonz/sbc-sip-sidecar/workflows/CI/badge.svg)

This application provides a part of the SBC (Session Border Controller) functionality of jambonz platform. It handles incoming/outgoing REGISTER requests from/to clients/servers (including both sip softphones and WebRTC client applications), incoming OPTIONS. Register Authentication is delegated to customer-side logic via a web callback configured for the account in the jambonz database.  Information about active registrations is stored in a redis database.

## Configuration

Configuration is provided via environment variables:

| variable | meaning | required?|
|----------|----------|---------|
|DRACHTIO_HOST| ip address of drachtio server (typically '127.0.0.1')|yes|
|DRACHTIO_PORT| listening port of drachtio server for control connections (typically 9022)|yes|
|DRACHTIO_SECRET| shared secret|yes|
|JAMBONES_LOGLEVEL| log level for application, 'info' or 'debug'|no|
|JAMBONES_MYSQL_HOST| mysql host|yes|
|JAMBONES_MYSQL_USER| mysql username|yes|
|JAMBONES_MYSQL_PASSWORD|  mysql password|yes|
|JAMBONES_MYSQL_DATABASE| mysql data|yes|
|JAMBONES_MYSQL_PORT| mysql port |no|
|JAMBONES_MYSQL_CONNECTION_LIMIT| mysql connection limit |no|
|JAMBONES_CLUSTER_ID| cluster id |no|
|JAMBONES_REDIS_HOST| redis host|yes|
|JAMBONES_REDIS_PORT|redis port|no|
|JAMBONES_TIME_SERIES_HOST| influxdb host |yes|
|CHECK_EXPIRES_INTERVAL| servers expiration check interval |no|
|EXPIRES_INTERVAL| servers expire |no|
|JWT_SECRET| secret for signing JWT token |yes|
|ENCRYPTION_SECRET| secret for credential encryption(JWT_SECRET is deprecated) |yes|
|JAMBONES_REGBOT_DEFAULT_EXPIRES_INTERVAL| default expire value for outbound registration in seconds (default 3600) |no|
|JAMBONES_REGBOT_MIN_EXPIRES_INTERVAL| minimum expire value for outbound registration in seconds (default 30) |no|

## Registrar database

A redis database is used to hold active registrations. When a register request arrives and is authenticated, the following values are parsed from the request:
- the address of record, or "aor" (e.g, daveh@drachtio.org),
- the sip uri, or "contact" that this user is advertising (e.g. sip:daveh@3.44.3.12:5060)
- the source address and port that sent the REGISTER request to the server
- the transport protocol that should be used to contact the user (e.g. udp, tcp, wss etc)
- the sip address of the drachtio server that received the REGISTER request, and
- the expiration of the registration, in seconds.
- the application callback that should be invoked when a call is placed from this registered device
- the application status callback that should invoked for call events on calls placed from this registered device

A hash value is created from these values and stored with an expiry value equal to the number of seconds granted to the registration (note that when a sip client is detected as being behind a firewall, the application will reduce the granted expires value to 30 seconds, in order to force the client to re-register frequently, however the expiry in redis is set to the longer, originally requested expires value).

The hash value is inserted with a key being the aor:
```
aor => {contact, source, protocol, sbcAddress, call_hook, call_status_hook}, expiry = registration expires value
```

## http callback
Authenticating users is the responsibility of the client by exposing an http callback.  A POST request will be sent to the configured callback (i.e. the value in the `accounts.registration_hook` column in the associated sip realm value in the REGISTER request).  The body of the POST will be a json payload including the following information:
```
{
	"method": "REGISTER",
	"expires": 3600,
	"scheme": "digest",
	"username": "john",
	"realm": "jambonz.org",
	"nonce": "157590482938000",
	"uri": "sip:172.37.0.10:5060",
	"response": "be641cf7951ff23ab04c57907d59f37d",
	"qop": "auth",
	"nc": "00000001",
	"cnonce": "6b8b4567",
	"algorithm": "MD5"
}
```
It is the responsibility of the customer-side logic to retrieve the associated password for the given username and to then authenticate the request by calculating a response hash value (per the algorithm described in [RFC 2617](https://tools.ietf.org/html/rfc2617#section-3.2.2)) and comparing it to the response property in the http body.

For example code showing how to calculate the response hash given the above inputs, [see here](https://github.com/jambonz/customer-auth-server/blob/master/lib/utils.js).

For a simple, full-fledged example server doing the same, [see here](https://github.com/jambonz/customer-auth-server).

The customer server SHOULD return a 200 OK response to the http request in all cases with a json body indicating whether the request was successfully authenticated.

The body MUST include a `status` field with a value of either `ok` or `fail`, indicating whether the request was authenticated or not.
```
{"status": "ok"}
```

Additionally, in the case of failure, the body MAY include a `msg` field with a human-readable description of why the authentication failed.
```
{"status": "fail", "msg": "invalid username"}
```

In the case of success, the body MAY include an `expires` value which specifies the duration of time, in seconds, to grant for this registration.  If not provided, the expires value in the REGISTER request is used; if provided, however, the value provided must be less than or equal to the duration requested.
```
{"status": "ok", "expires": 300}
```

Additionally in the case of success, the body SHOULD include `call_hook` and `call_status_hook` properties that reference the application URLs to use when calls are placed from this device.  If these values are not provided, outbound calling from the device will not be allowed.

## Running the test suite
To run the included test suite, you will need to have a mysql server installed on your laptop/server. You will need to set the MYSQL_ROOT_PASSWORD env variable to the mysql root password before running the tests.  The test suite creates a database named 'jambones_test' in your mysql server to run the tests against, and removes it when done.
```
MYSQL_ROOT_PASSWORD=foobar npm test
```
