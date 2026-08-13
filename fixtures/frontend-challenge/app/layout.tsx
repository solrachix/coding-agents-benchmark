import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "Event Atlas", description: "Explore events" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
