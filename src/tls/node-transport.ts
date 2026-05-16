import { Agent, ProxyAgent, fetch, type Dispatcher } from "undici";
import type { TlsTransport, TlsTransportResponse } from "./transport.js";
import { getProxyUrl } from "./proxy.js";

function resolveProxy(proxyUrl: string | null | undefined): string | null {
  if (proxyUrl === null) return null;
  if (proxyUrl !== undefined) return proxyUrl;
  return getProxyUrl();
}

export class NodeTransport implements TlsTransport {
  private readonly directDispatcher = new Agent();
  private readonly proxyDispatchers = new Map<string, Dispatcher>();

  private getDispatcher(proxyUrl: string | null): Dispatcher {
    if (!proxyUrl) return this.directDispatcher;

    let dispatcher = this.proxyDispatchers.get(proxyUrl);
    if (!dispatcher) {
      dispatcher = new ProxyAgent(proxyUrl);
      this.proxyDispatchers.set(proxyUrl, dispatcher);
    }
    return dispatcher;
  }

  private async request(
    method: "GET" | "POST",
    url: string,
    headers: Record<string, string>,
    body?: string,
    signal?: AbortSignal,
    proxyUrl?: string | null,
  ): Promise<TlsTransportResponse> {
    const proxy = resolveProxy(proxyUrl);
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal,
      dispatcher: this.getDispatcher(proxy),
      duplex: body === undefined ? undefined : "half",
    });

    return {
      status: response.status,
      headers: response.headers,
      body: response.body ?? new ReadableStream<Uint8Array>(),
      setCookieHeaders: response.headers.getSetCookie(),
    };
  }

  destroy(): void {
    void this.directDispatcher.close();
    for (const dispatcher of this.proxyDispatchers.values()) {
      void dispatcher.close();
    }
    this.proxyDispatchers.clear();
  }

  isImpersonate(): boolean {
    return false;
  }

  async post(
    url: string,
    headers: Record<string, string>,
    body: string,
    signal?: AbortSignal,
    _timeoutSec?: number,
    proxyUrl?: string | null,
  ): Promise<TlsTransportResponse> {
    return this.request("POST", url, headers, body, signal, proxyUrl);
  }

  async get(
    url: string,
    headers: Record<string, string>,
    _timeoutSec?: number,
    proxyUrl?: string | null,
  ): Promise<{ status: number; body: string }> {
    const response = await this.request("GET", url, headers, undefined, undefined, proxyUrl);
    return {
      status: response.status,
      body: await new Response(response.body).text(),
    };
  }

  async getWithCookies(
    url: string,
    headers: Record<string, string>,
    _timeoutSec?: number,
    proxyUrl?: string | null,
  ): Promise<{ status: number; body: string; setCookieHeaders: string[] }> {
    const response = await this.request("GET", url, headers, undefined, undefined, proxyUrl);
    return {
      status: response.status,
      body: await new Response(response.body).text(),
      setCookieHeaders: response.setCookieHeaders,
    };
  }

  async simplePost(
    url: string,
    headers: Record<string, string>,
    body: string,
    _timeoutSec?: number,
    proxyUrl?: string | null,
  ): Promise<{ status: number; body: string }> {
    const response = await this.request("POST", url, headers, body, undefined, proxyUrl);
    return {
      status: response.status,
      body: await new Response(response.body).text(),
    };
  }
}

export async function createNodeTransport(): Promise<NodeTransport> {
  return new NodeTransport();
}
