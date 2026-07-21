import http2 from 'node:http2';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { NetworkDeniedError } from '../src/errors.ts';

function deny(): never {
  throw new NetworkDeniedError('Network access is disabled in default tests');
}
globalThis.fetch = (() => Promise.reject(new NetworkDeniedError('Network access is disabled in default tests'))) as typeof fetch;
http.request = (() => deny()) as typeof http.request;
http.get = (() => deny()) as typeof http.get;
https.request = (() => deny()) as typeof https.request;
https.get = (() => deny()) as typeof https.get;
net.connect = (() => deny()) as typeof net.connect;
net.createConnection = (() => deny()) as typeof net.createConnection;
tls.connect = (() => deny()) as typeof tls.connect;
http2.connect = (() => deny()) as typeof http2.connect;
