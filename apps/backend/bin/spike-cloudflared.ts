#!/usr/bin/env bun
/**
 * spike-cloudflared.ts — Cloudflare Tunnel resilience spike server.
 *
 * Purpose: receive GitHub webhook POSTs forwarded through `cloudflared` and
 * log delivery timestamps so we can measure how many of N test deliveries
 * survive a simulated tunnel outage.
 *
 * Sidecar contract:
 *   - cloudflared runs OUT-OF-PROCESS (launchd on macOS / systemd-user on Linux)
 *   - cloudflared terminates TLS at Cloudflare edge and proxies cleartext to 127.0.0.1:8787
 *   - this server binds 127.0.0.1 ONLY (never 0.0.0.0) — assumes a trusted loopback
 *   - no auth, no HMAC verification — this is a measurement tool, not production code
 *
 * Test methodology:
 *   1. Start this server.
 *   2. Start cloudflared with a Quick Tunnel pointing at http://127.0.0.1:8787.
 *   3. Configure a GitHub webhook to send `ping` events to the tunnel URL.
 *   4. Trigger 10 deliveries (e.g. webhook ping button x10, or repo touch x10).
 *   5. Kill cloudflared for 90 seconds mid-burst.
 *   6. Count rows in the log to derive `received: X/10`.
 *
 * See docs/spikes/cloudflared.md for the recorded outcome and decision.
 */

const HOSTNAME = "127.0.0.1";
const PORT = 8787;

let counter = 0;

const server = Bun.serve({
  hostname: HOSTNAME,
  port: PORT,
  async fetch(req) {
    if (req.method !== "POST") {
      return new Response("spike-cloudflared: POST only", { status: 405 });
    }

    counter += 1;
    const seq = counter;
    const at = new Date().toISOString();
    const event = req.headers.get("x-github-event") ?? "(none)";
    const delivery = req.headers.get("x-github-delivery") ?? "(none)";
    const contentLength = req.headers.get("content-length") ?? "0";

    // Drain body so the client sees a clean 200 (matches what the real
    // webhook handler does — cloudflared keeps the connection alive only
    // until we respond).
    await req.text();

    // biome-ignore lint/suspicious/noConsole: spike measurement tool; stdout IS the log sink
    console.log(
      JSON.stringify({
        seq,
        at,
        event,
        delivery,
        bytes: Number(contentLength),
      }),
    );

    return new Response("ok", { status: 200 });
  },
});

// biome-ignore lint/suspicious/noConsole: spike measurement tool; stdout IS the log sink
console.log(`spike-cloudflared listening on http://${server.hostname}:${server.port} (POST only)`);
// biome-ignore lint/suspicious/noConsole: spike measurement tool; stdout IS the log sink
console.log(
  "point cloudflared at this address and run the 90s-outage methodology in docs/spikes/cloudflared.md",
);
