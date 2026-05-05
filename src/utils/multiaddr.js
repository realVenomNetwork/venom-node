"use strict";

function isPrivateOrWildcardMultiaddr(addr) {
  const str = addr.toString();
  if (str.includes("/ip4/0.0.0.0/") || str.includes("/ip4/127.")) return true;
  const ipMatch = str.match(/\/ip4\/(\d+\.\d+\.\d+\.\d+)\//);
  if (ipMatch) {
    const octets = ipMatch[1].split(".").map(Number);
    if (octets[0] === 10) return true;
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
    if (octets[0] === 192 && octets[1] === 168) return true;
  }
  return false;
}

module.exports = {
  isPrivateOrWildcardMultiaddr
};
