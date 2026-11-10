export class TailscaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TailscaleError";
  }
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function run(args: string[]): CommandResult {
  const result = Bun.spawnSync({
    cmd: ["tailscale", ...args],
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

export function parseTailscaleStatus(json: string): string {
  let parsed: { BackendState?: string; Self?: { DNSName?: string } };

  try {
    parsed = JSON.parse(json) as typeof parsed;
  } catch {
    throw new TailscaleError("Could not parse `tailscale status --json`.");
  }

  if (parsed.BackendState !== "Running") {
    throw new TailscaleError("Tailscale is not running. Run `tailscale up` first.");
  }

  const dnsName = parsed.Self?.DNSName?.replace(/\.$/, "");
  if (!dnsName) {
    throw new TailscaleError(
      "Could not read the Tailscale DNS name. Enable MagicDNS and HTTPS for this tailnet.",
    );
  }

  return dnsName;
}

export function serveStatusHasPort(json: string, httpsPort: number): boolean {
  try {
    const parsed = JSON.parse(json) as { Web?: Record<string, unknown> };
    return Object.keys(parsed.Web ?? {}).some((key) => key.endsWith(`:${httpsPort}`));
  } catch {
    return false;
  }
}

export function tailscaleUrl(dnsName: string, httpsPort: number): string {
  return httpsPort === 443
    ? `https://${dnsName}`
    : `https://${dnsName}:${httpsPort}`;
}

export interface PreparedTailscale {
  dnsName: string;
  publicUrl: string;
  httpsPort: number;
}

export function prepareTailscale(httpsPort: number, force: boolean): PreparedTailscale {
  if (!Bun.which("tailscale")) {
    throw new TailscaleError("The `tailscale` CLI was not found on PATH.");
  }

  const status = run(["status", "--json"]);
  if (status.exitCode !== 0) {
    throw new TailscaleError(
      `Could not read Tailscale status: ${status.stderr.trim() || status.stdout.trim()}`,
    );
  }

  const dnsName = parseTailscaleStatus(status.stdout);

  if (!force) {
    const serveStatus = run(["serve", "status", "--json"]);
    if (serveStatus.exitCode === 0 && serveStatusHasPort(serveStatus.stdout, httpsPort)) {
      throw new TailscaleError(
        `Tailscale Serve already has a handler on port ${httpsPort}. Use --tailscale-port to pick another port or --tailscale-force to replace it.`,
      );
    }
  }

  return {
    dnsName,
    publicUrl: tailscaleUrl(dnsName, httpsPort),
    httpsPort,
  };
}

export function startTailscaleServe(localPort: number, httpsPort: number): void {
  const result = run([
    "serve",
    "--bg",
    `--https=${httpsPort}`,
    `http://127.0.0.1:${localPort}`,
  ]);

  if (result.exitCode !== 0) {
    throw new TailscaleError(
      `tailscale serve failed: ${result.stderr.trim() || result.stdout.trim()}. ` +
        "Check that HTTPS certificates are enabled for your tailnet.",
    );
  }
}

export function stopTailscaleServe(httpsPort: number): void {
  const result = run(["serve", `--https=${httpsPort}`, "off"]);

  if (result.exitCode !== 0) {
    console.warn(
      `[notify] could not remove the Tailscale Serve handler on ${httpsPort}: ${
        result.stderr.trim() || result.stdout.trim()
      }`,
    );
  }
}
