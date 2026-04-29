import dns from "node:dns";
import fs from "node:fs";
import type http from "node:http";
import https from "node:https";

const PORTLESS_CA_PATH = "/tmp/portless/ca.pem";
const nativeFetch = globalThis.fetch;

export const cliFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.protocol !== "https:" || !isLocalTlsHost(url.hostname)) {
    return fetch(request);
  }
  if (globalThis.fetch !== nativeFetch) return fetch(request);
  try {
    return await nativeFetch(request.clone());
  } catch {
    // Fall back to the local portless transport below.
  }
  return localHttpsFetch(request, url);
};

async function localHttpsFetch(request: Request, url: URL): Promise<Response> {
  const body = await request.arrayBuffer();
  const headers = Object.fromEntries(request.headers.entries());

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        agent: localHttpsAgent(),
        headers,
        method: request.method,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          resolve(
            new Response(Buffer.concat(chunks), {
              headers: responseHeaders(res.headers),
              status: res.statusCode ?? 0,
              statusText: res.statusMessage,
            }),
          );
        });
      },
    );
    req.on("error", (error) => {
      reject(new TypeError("fetch failed", { cause: error }));
    });
    if (body.byteLength > 0) req.end(Buffer.from(body));
    else req.end();
  });
}

function localHttpsAgent(): http.Agent | https.Agent {
  const ca = readPortlessCa();
  return new https.Agent({
    ...(ca ? { ca } : { rejectUnauthorized: false }),
    lookup(hostname, optionsOrCallback, maybeCallback) {
      const callback =
        typeof optionsOrCallback === "function"
          ? optionsOrCallback
          : maybeCallback;
      if (!callback) return;
      if (isLocalTlsHost(hostname)) {
        if (
          typeof optionsOrCallback === "object" &&
          optionsOrCallback !== null &&
          "all" in optionsOrCallback &&
          optionsOrCallback.all === true
        ) {
          callback(null, [{ address: "127.0.0.1", family: 4 }]);
          return;
        }
        callback(null, "127.0.0.1", 4);
        return;
      }
      if (typeof optionsOrCallback === "function") {
        dns.lookup(hostname, callback);
        return;
      }
      dns.lookup(hostname, optionsOrCallback, callback);
    },
  });
}

function responseHeaders(headers: http.IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else {
      result.set(name, value);
    }
  }
  return result;
}

function isLocalTlsHost(hostname: string): boolean {
  return hostname.endsWith(".local") || hostname.endsWith(".localhost");
}

function readPortlessCa(): Buffer | undefined {
  try {
    return fs.readFileSync(PORTLESS_CA_PATH);
  } catch {
    return undefined;
  }
}
