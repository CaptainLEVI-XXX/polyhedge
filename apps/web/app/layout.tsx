import type { ReactNode } from 'react';

export const metadata = {
  title: 'PolyHedge',
  description: 'Describe what you would lose. See what it costs to cover.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
