import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin();

const isDev = process.env.NODE_ENV === "development";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  compress: true,

  // Self-contained server bundle for the VPS: `.next/standalone` carries its own
  // traced `node_modules`, so a release is ~16MB packed instead of a full install.
  // `.next/static` and `public/` are deliberately left out of it by Next and must
  // be placed alongside the server — scripts/package-release.sh does that, and
  // also copies `content/`, which /blog reads from disk at request time.
  output: "standalone",

  // Keep nodemailer (src/lib/mail.ts) a real runtime require instead of letting
  // webpack bundle it. Its transports are resolved dynamically, which the bundler
  // mangles; as an external, Next's dependency tracer copies the package into
  // .next/standalone/node_modules intact. scripts/package-release.sh asserts it
  // landed there — a missing traced dependency is a production-only 500.
  serverExternalPackages: ["nodemailer"],

  // The app served no security headers at all: no CSP, nothing pinning the frame
  // policy, nothing stopping a sniffed content type. Apache fronts the standalone
  // server and could set these, but then they live on the VPS instead of in the
  // repo, where a redeploy to anywhere else quietly loses them.
  async headers() {
    // React refresh evaluates the modules it swaps in, so `unsafe-eval` is the
    // price of HMR. Production never gets it.
    const scriptSrc = [
      "'self'",
      // Next inlines hydration data and the flash-of-wrong-theme guard, and the GTM
      // bootstrap in layout.tsx is inline too. All three are build-authored, but CSP
      // cannot tell them from an injected one without a nonce — which needs
      // middleware this app deliberately does not have. The remaining directives are
      // still worth having, so this stays honest about what it does not buy.
      "'unsafe-inline'",
      "https://www.googletagmanager.com",
      ...(isDev ? ["'unsafe-eval'"] : []),
    ].join(" ");

    const csp = [
      "default-src 'self'",
      `script-src ${scriptSrc}`,
      // Tailwind's runtime layer and framer-motion both write style attributes.
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://www.googletagmanager.com https://www.google-analytics.com",
      // next/font/google self-hosts at build time, so no external font origin.
      "font-src 'self' data:",
      "connect-src 'self' https://www.googletagmanager.com https://www.google-analytics.com https://*.analytics.google.com",
      // The GTM noscript iframe in layout.tsx.
      "frame-src https://www.googletagmanager.com",
      "object-src 'none'",
      // Neither is used, and both are how an injected tag rewrites where relative
      // URLs and form posts actually go.
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      ...(isDev ? [] : ["upgrade-insecure-requests"]),
    ].join("; ");

    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          // frame-ancestors already covers this for current browsers; kept for the
          // ones that only honour the older header.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Send the origin cross-site, the full path same-origin. The contact page
          // carries no query string worth leaking, but /blog paths are still ours.
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Nothing here asks for hardware. Denying it means an injected third-party
          // tag cannot either.
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
          },
          // Deliberately without includeSubDomains: bak-dev.com's MX and Virtualmin
          // panel are siblings on the same box, and pinning them to HTTPS from here
          // would be a decision this app has no business making for them.
          { key: "Strict-Transport-Security", value: "max-age=63072000" },
        ],
      },
    ];
  },

  // Portfolio / Modules / Themes collapsed into a single filterable /work grid.
  // Permanent so existing inbound links and search results follow.
  async redirects() {
    return [
      { source: "/portfolio", destination: "/work", permanent: true },
      { source: "/modules", destination: "/work", permanent: true },
      { source: "/themes", destination: "/work", permanent: true },
    ];
  },
};

export default withNextIntl(nextConfig);
