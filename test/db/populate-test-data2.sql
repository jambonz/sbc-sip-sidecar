insert into voip_carriers (voip_carrier_sid, name, e164_leading_plus, requires_register, register_username, register_sip_realm, register_password, register_from_user, register_from_domain, register_public_ip_in_contact) 
values ('287c1452-620d-4195-9f19-c9814ef90d78', 'westco', 1, 1, 'foo', 'sip.jambonz.org', 'bar', 'reguser', 'regdomain', 0);
insert into sip_gateways (sip_gateway_sid, voip_carrier_sid, ipv4, inbound, outbound, send_options_ping) 
values ('124a5339-c62c-4075-9e19-f4de70a96597', '287c1452-620d-4195-9f19-c9814ef90d78', '172.39.0.14', true, true, true);
