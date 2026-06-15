/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@bharat-benefits/shared'],

  /**
   * Performance optimizations for Requirement 19.5:
   * - FCP ≤ 3s on simulated 4G (9 Mbps downlink, 170ms RTT)
   * - Lighthouse mobile performance score ≥ 80
   */
  images: {
    // Enable Next.js image optimization for responsive images
    formats: ['image/avif', 'image/webp'],
    deviceSizes: [320, 420, 640, 768, 1024, 1280, 1536],
    imageSizes: [16, 32, 48, 64, 96, 128, 256],
  },

  // Compress responses for faster transfer on 4G
  compress: true,

  // Optimize CSS loading
  experimental: {
    optimizeCss: false, // Set to true if critters is installed
  },

  // Font optimization (automatic with Next.js 14)
  optimizeFonts: true,
};

export default nextConfig;
