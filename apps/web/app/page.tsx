export default function Home() {
  return (
    <main style={{ padding: 32, fontFamily: 'ui-monospace, monospace' }}>
      <h1 style={{ fontSize: 20, margin: 0 }}>PolyHedge</h1>
      <p style={{ color: '#6b6b6b', fontSize: 13 }}>
        Shell only. The solver health check lives at <code>/api/health</code>.
      </p>
    </main>
  );
}
