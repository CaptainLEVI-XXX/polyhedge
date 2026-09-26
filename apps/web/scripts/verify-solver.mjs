/**
 * Checks that the LP solver really loads in the running app.
 *
 * Deliberately NOT a vitest test. Vitest runs under plain Node, where `highs`
 * always loads — so a unit test here would pass in exactly the configuration
 * that breaks production: `serverExternalPackages` or the webpack externals
 * missing, the `.wasm` bundled, and every solve failing at request time.
 *
 * The only runtime whose answer means anything is the one that serves traffic,
 * so this asks that one. Run it against a dev or built server.
 */
const url = process.env.HEALTH_URL ?? 'http://localhost:3000/api/health';

let body;
try {
  const res = await fetch(url);
  body = await res.json();
} catch (error) {
  console.error(`could not reach ${url} — is the app running?`);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

if (body?.ok !== true) {
  console.error('solver did not load:', JSON.stringify(body));
  process.exit(1);
}

console.log(`solver ok — ${body.solver}, ${body.variables} variables in ${body.tookMs}ms`);
