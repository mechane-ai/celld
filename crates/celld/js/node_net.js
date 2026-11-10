// Copyright 2026 Deno Land Inc. Apache-2.0 license.

(() => {
  "use strict";

  const isIPv4 = (input) => {
    const value = `${input}`;
    const segments = value.split(".");
    return segments.length === 4 && segments.every((segment) =>
      /^(0|[1-9][0-9]{0,2})$/.test(segment) && Number(segment) <= 255
    );
  };

  const isIPv6 = (input) => {
    let value = `${input}`;
    const zone = value.indexOf("%");
    if (zone !== -1) {
      if (!/^[0-9a-zA-Z.:-]+$/.test(value.slice(zone + 1))) return false;
      value = value.slice(0, zone);
    }
    const halves = value.split("::");
    if (halves.length > 2) return false;
    const groups = halves.flatMap((half) => half === "" ? [] : half.split(":"));
    let count = groups.length;
    const last = groups.at(-1);
    if (last?.includes(".")) {
      if (!value.endsWith(last) || !isIPv4(last)) return false;
      groups.pop();
      count += 1;
    }
    if (!groups.every((group) => /^[0-9a-fA-F]{1,4}$/.test(group))) return false;
    return halves.length === 2 ? count < 8 : count === 8;
  };

  const isIP = (input) => {
    if (isIPv4(input)) return 4;
    if (isIPv6(input)) return 6;
    return 0;
  };

  const unsupported = __celld.__nodeStubFor("node:net");
  __celld.__netModule = new Proxy({ isIP, isIPv4, isIPv6 }, {
    get(target, property) {
      return property in target ? target[property] : unsupported[property];
    },
  });
})();
