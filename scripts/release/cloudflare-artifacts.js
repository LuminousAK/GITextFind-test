export const PAGES_HEADERS = `/*
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()

/*.js
  Cache-Control: public, max-age=0, must-revalidate

/
  Cache-Control: no-store

/index.html
  Cache-Control: no-store

/runtime-config.json
  Cache-Control: no-store
`;
