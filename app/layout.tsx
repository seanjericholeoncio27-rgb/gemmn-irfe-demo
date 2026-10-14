
// ============================================================
// FILE: app/layout.tsx
// ============================================================
import type { Metadata } from 'next'
export const metadata: Metadata = { title: 'GEMMN IRFE System', description: 'Integrated Resource & Financial Ecosystem' }
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700;900&display=swap" rel="stylesheet" />
      </head>
      <body style={{ margin: 0, fontFamily: "'Roboto', sans-serif", background: '#f4f7f5' }}>
        {children}
      </body>
    </html>
  )
}