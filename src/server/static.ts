import { readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const ALLOWED = new Set([
  "index.html",
  "app.js",
  "app.css",
  "sw.js",
  "manifest.webmanifest",
  "icons/icon.svg",
  "icons/icon-180.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
]);

function contentType(path: string): string {
  const index = path.lastIndexOf(".");
  const ext = index === -1 ? "" : path.slice(index).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

export function createStaticServer(publicDir: string): (pathname: string) => Response | null {
  const cache = new Map<string, Uint8Array>();

  return (pathname: string): Response | null => {
    let relative: string;

    if (pathname === "/" || pathname === "/enroll") {
      relative = "index.html";
    } else {
      relative = normalize(pathname.replace(/^\/+/, ""));
      if (relative.startsWith("..") || relative.includes("\0")) return null;
      if (!ALLOWED.has(relative)) return null;
    }

    const filePath = join(publicDir, relative);

    try {
      const stats = statSync(filePath);
      if (!stats.isFile()) return null;

      let body = cache.get(filePath);
      if (!body) {
        body = new Uint8Array(readFileSync(filePath));
        cache.set(filePath, body);
      }

      const headers = new Headers({
        "Content-Type": contentType(relative),
      });

      if (relative === "sw.js") {
        headers.set("Cache-Control", "no-cache");
        headers.set("Service-Worker-Allowed", "/");
      } else if (relative === "index.html") {
        headers.set("Cache-Control", "no-cache");
      } else {
        headers.set("Cache-Control", "public, max-age=3600");
      }

      return new Response(body as unknown as BodyInit, { status: 200, headers });
    } catch {
      return null;
    }
  };
}
