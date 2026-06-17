/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@bharat-benefits/shared'],

  /**
   * Skip ESLint during `next build`. We already lint the whole repo in
   * CI via `npm run lint` (see .github/workflows/ci.yml). Re-running it
   * during the Next production build duplicates work AND requires
   * `eslint` to be a direct dep of the frontend workspace — which it
   * isn't, because lint config + plugins live at the repo root. Leaving
   * the default enabled makes Vercel's per-package install fail with
   * "ESLint must be installed in order to run during builds".
   */
  eslint: {
    ignoreDuringBuilds: true,
  },

  /**
   * Skip TypeScript errors during `next build` for the same reason:
   * the repo's typecheck step runs in CI against the workspace
   * tsconfig (see CI's `npx tsc -p packages/frontend --noEmit`), and
   * Vercel's per-workspace install may not pull in every devDep
   * needed for Next's in-build typecheck. CI remains the source of
   * truth for type safety; a typecheck regression there blocks merge.
   */
  typescript: {
    ignoreBuildErrors: true,
  },

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
