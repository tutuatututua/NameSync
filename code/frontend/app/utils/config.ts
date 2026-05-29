// Centralized API/WebSocket base URLs. Override via NEXT_PUBLIC_* env vars.
//
// When the env vars are unset we derive the host from the address the page was
// loaded from (window.location), so a visitor reaching the site at e.g.
// http://192.168.1.50:3000 will call the API at http://192.168.1.50:8080.
// Hardcoding "localhost" only works on the machine running the server, which is
// why remote visitors saw "failed to fetch localhost:8080".

const API_PORT = '8080';

function deriveBaseUrl(protocol: string, suffix: string): string {
  if (typeof window !== 'undefined' && window.location?.hostname) {
    return `${protocol}//${window.location.hostname}:${API_PORT}${suffix}`;
  }
  return `${protocol}//localhost:${API_PORT}${suffix}`;
}

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || deriveBaseUrl('http:', '/api');

export const WS_BASE_URL =
  process.env.NEXT_PUBLIC_WS_BASE_URL || deriveBaseUrl('ws:', '/ws');
