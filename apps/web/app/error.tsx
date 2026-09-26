'use client';

/**
 * The last thing between a crash and the user.
 *
 * It never shows the error. A stack trace tells a stranger nothing they can
 * act on and can leak internals, so the detail goes to the console where it
 * helps and the page says the one thing that actually matters here: nothing
 * was placed.
 */
export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="wrap">
      <div className="bar">
        <span className="brand">polyhedge</span>
      </div>
      <div className="box">
        <div className="body">
          <h2 className="statement">Something broke on our side.</h2>
          <p style={{ color: 'var(--ink-2)' }}>
            No order was placed and no money moved. Nothing you were looking at was acted on.
          </p>
          <button className="primary" onClick={reset} style={{ marginTop: 8 }}>
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}
