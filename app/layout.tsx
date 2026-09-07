import type { Metadata, Viewport } from 'next';
import './globals.css';

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://ourpersonalbill.netlify.app';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: 'SplitMate — household bills, sorted',
  description: 'Scan bills from Photos, share costs equally, and see exactly who pays whom.',
  applicationName: 'SplitMate',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'SplitMate' },
  icons: { icon: '/app-icon.svg', apple: '/apple-touch-icon.png' },
  openGraph: { title: 'SplitMate', description: 'Household bills, sorted.', images: ['/og.png'] },
  twitter: { card: 'summary_large_image', title: 'SplitMate', description: 'Household bills, sorted.', images: ['/og.png'] },
};

export const viewport: Viewport = { themeColor: '#f7f7f9', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
