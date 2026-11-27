import { Resolver } from 'node:dns/promises'
import { BlockList, isIPv4 } from 'node:net'

const hostname = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i
const specialAddresses = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) {
  specialAddresses.addSubnet(network, prefix)
}

export function isMailcowHostname(value) {
  return typeof value === 'string' && hostname.test(value)
}

export async function resolveMailcowAddress(host, resolver = new Resolver({ timeout: 4_000, tries: 1 })) {
  if (!isMailcowHostname(host)) throw new Error('Invalid Mailcow hostname')
  const addresses = await resolver.resolve4(host)
  if (!addresses.length || addresses.some(address => !isIPv4(address) || specialAddresses.check(address))) {
    throw new Error('Mailcow must resolve to public IPv4 addresses')
  }
  return addresses[0]
}
