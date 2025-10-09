delete from sip_gateways;
delete from voip_carriers;
insert into voip_carriers (voip_carrier_sid, name, e164_leading_plus, requires_register, register_username, register_sip_realm, register_password, register_from_user, register_public_ip_in_contact, trunk_type) 
values ('287c1452-620d-4195-9f19-c9814ef90d78', 'westco', 1, 1, 'daveh', 'beachdog.sip.jambonz.cloud', 'foobarbazzle', 'daveh', 0, 'reg');
insert into sip_gateways (sip_gateway_sid, voip_carrier_sid, ipv4, port, inbound, outbound, send_options_ping) 
values ('124a5339-c62c-4075-9e19-f4de70a96597', '287c1452-620d-4195-9f19-c9814ef90d78', 'beachdog.sip.jambonz.cloud', 5060, false, true, false);
