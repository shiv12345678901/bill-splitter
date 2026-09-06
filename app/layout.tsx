import type { Metadata, Viewport } from 'next';
import { Geist } from 'next/font/google';
import './globals.css';

const geist = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });

export const metadata: Metadata = {
  metadataBase: new URL('https://splitmate-household.expert-spool-1662.chatgpt.site'),
  title: 'SplitMate — household bills, sorted',
  description: 'Snap receipts, see fair shares, and settle household expenses without the awkward maths.',
  applicationName: 'SplitMate',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'SplitMate' },
  openGraph: { title: 'SplitMate', description: 'Household bills, sorted.', images: ['/og.png'] },
  twitter: { card: 'summary_large_image', title: 'SplitMate', description: 'Household bills, sorted.', images: ['/og.png'] },
};

export const viewport: Viewport = { themeColor: '#f7f7f9', width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className={`${geist.variable} antialiased`}>{children}</body></html>;
}
