export interface ServeOptions {
  dev: boolean;
  tailscale: boolean;
  tailscalePort: number;
  tailscaleForce: boolean;
  tailscaleKeep: boolean;
}

function parsePort(value: string): number {
  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --tailscale-port: ${value}`);
  }

  return port;
}

export function parseServeArgs(args: string[]): ServeOptions {
  let tailscalePort = 8443;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--tailscale-port") {
      const next = args[index + 1];
      if (!next) throw new Error("--tailscale-port requires a port number");
      tailscalePort = parsePort(next);
      index += 1;
      continue;
    }

    if (arg.startsWith("--tailscale-port=")) {
      tailscalePort = parsePort(arg.slice("--tailscale-port=".length));
    }
  }

  return {
    dev: args.includes("--dev"),
    tailscale: args.includes("--tailscale"),
    tailscalePort,
    tailscaleForce: args.includes("--tailscale-force"),
    tailscaleKeep: args.includes("--tailscale-keep"),
  };
}
