'use client';

import { useState, type ReactNode } from 'react';

/**
 * A section that starts closed.
 *
 * Used for the parts of a basket that are verification rather than decision:
 * the individual markets, the raw receipt. Someone deciding whether to buy
 * protection does not need eleven market questions in front of them, but
 * someone checking our arithmetic needs all of them — and the second person
 * should not have to ask for a different page.
 *
 * The summary line carries the count, so what is inside is known before it is
 * opened. A disclosure that hides how much it hides is just a surprise.
 */
export function Disclosure({
  title,
  aside,
  children,
  defaultOpen = false,
}: {
  title: string;
  aside?: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="section">
      <h3>
        <button className="disclose" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="caret" aria-hidden>{open ? '−' : '+'}</span>
          {title}
        </button>
        {aside !== undefined && <span className="aside">{aside}</span>}
      </h3>
      {open && children}
    </section>
  );
}
