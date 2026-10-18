import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionAddresses } from '../src/transport/server.mjs';

const entry = (address, internal = false) => ({ address, internal, family: address.includes(':') ? 'IPv6' : 'IPv4' });

test('connection candidates prefer IPv4, preserve family order and remove duplicates', () => {
  const interfaces = {
    eth0: [entry('2001:db8::1'), entry('192.168.1.10'), entry('192.168.1.10')],
    wlan0: [entry('fd12::2'), entry('10.0.0.8'), entry('2001:db8::1')],
    unused: undefined,
  };
  assert.deepEqual(connectionAddresses(undefined, interfaces), ['192.168.1.10', '10.0.0.8', '2001:db8::1', 'fd12::2']);
  assert.deepEqual(connectionAddresses('0.0.0.0', interfaces), ['192.168.1.10', '10.0.0.8']);
});

test('explicit bindings advertise only their configured address', () => {
  const interfaces = { eth0: [entry('192.168.1.10')] };
  for (const host of ['192.168.1.20', '2001:db8::2', '127.0.0.1', 'localhost']) {
    assert.deepEqual(connectionAddresses(host, interfaces), [host]);
  }
});

test('automatic LAN pairing prefers private addresses over a server public address', () => {
  const interfaces = { eth0: [entry('111.170.18.12')], wlan0: [entry('192.168.1.10')], Ethernet: [entry('10.0.0.8')] };
  assert.deepEqual(connectionAddresses('0.0.0.0', interfaces), ['192.168.1.10', '10.0.0.8', '111.170.18.12']);
});

test('connection candidates omit loopback, unspecified, link-local and invalid IPv4', () => {
  const excluded = ['127.1.2.3', '0.1.2.3', '169.254.1.2', '224.0.0.1', '239.1.2.3', '255.255.255.255', '999.1.2.3', 'not-an-ip'];
  const interfaces = { eth0: [...excluded.map(address => entry(address)), entry('192.168.1.10', true), entry('169.253.255.255'), entry('169.255.0.1'), entry('223.255.255.254')] };
  assert.deepEqual(connectionAddresses('::', interfaces), ['169.253.255.255', '169.255.0.1', '223.255.255.254']);
});

test('IPv6 link-local filtering covers the full /10 and scoped addresses', () => {
  const excluded = ['::', '::1', 'fe80::1', 'fe90::1', 'fea0::1', 'febf::1', 'FE80::2', 'ff02::1', '2001:db8::1%eth0'];
  const interfaces = { eth0: [...excluded.map(address => entry(address)), entry('fe7f::1'), entry('fec0::1'), entry('fd12::1'), entry('2001:db8::2')] };
  assert.deepEqual(connectionAddresses('::', interfaces), ['fe7f::1', 'fec0::1', 'fd12::1', '2001:db8::2']);
});

test('container and host-only adapters are omitted without hiding bridges or VPNs', () => {
  const interfaces = {
    docker0: [entry('172.17.0.1')],
    'br-012345abcdef': [entry('172.19.0.1')],
    veth1234: [entry('172.20.0.1')],
    virbr0: [entry('192.168.122.1')],
    vboxnet0: [entry('192.168.56.1')],
    'vEthernet (Default Switch)': [entry('172.21.0.1')],
    'vEthernet (WSL (Hyper-V firewall))': [entry('172.22.0.1')],
    'vEthernet (DockerNAT)': [entry('172.23.0.1')],
    br0: [entry('192.168.1.10')],
    tailscale0: [entry('100.64.0.10')],
    wg0: [entry('10.10.0.2')],
    tun0: [entry('10.20.0.2')],
    Ethernet: [entry('111.170.18.12')],
  };
  assert.deepEqual(connectionAddresses('::', interfaces), ['192.168.1.10', '10.10.0.2', '10.20.0.2', '100.64.0.10', '111.170.18.12']);
});

test('no suitable interfaces produces no fabricated connection candidates', () => {
  assert.deepEqual(connectionAddresses('::', {}), []);
  assert.deepEqual(connectionAddresses('0.0.0.0', { lo: [entry('127.0.0.1', true)], eth0: [entry('fe80::1')] }), []);
});
