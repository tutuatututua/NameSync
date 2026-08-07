import type { Config } from "tailwindcss";

/**
 * The theme is a thin projection of the tokens in globals.css — nothing here invents a
 * colour. Anything that needs a new one adds a CSS variable there first, so light and dark
 * can never drift apart.
 */
const config: Config = {
  darkMode: ["class"],
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
    "./hooks/**/*.{ts,tsx}",
  ],
  theme: {
    container: {
      center: true,
      padding: "1.5rem",
      screens: { "2xl": "1400px" },
    },
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)", "var(--font-thai)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
        // For a column that is known to hold Thai. Inter has no Thai coverage, so `font-sans`
        // only reaches Noto Sans Thai by falling through — which works, but leaves the Thai
        // glyphs at Inter's metrics. Naming the face puts it first.
        thai: ["var(--font-thai)", "var(--font-sans)", "system-ui", "sans-serif"],
        // Headings share Inter with the body — a second face would be decoration. They earn
        // their hierarchy from weight, size and tracking instead.
        display: ["var(--font-sans)", "var(--font-thai)", "system-ui", "sans-serif"],
      },

      /**
       * A real scale. Each step pairs a size with the line-height and tracking it actually
       * wants: small text needs air and neutral tracking, display text needs neither.
       */
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem", letterSpacing: "0.01em" }],
        xs: ["0.75rem", { lineHeight: "1.125rem", letterSpacing: "0.005em" }],
        sm: ["0.8125rem", { lineHeight: "1.25rem" }],
        base: ["0.875rem", { lineHeight: "1.5rem" }],
        md: ["0.9375rem", { lineHeight: "1.5rem" }],
        lg: ["1.0625rem", { lineHeight: "1.625rem", letterSpacing: "-0.005em" }],
        xl: ["1.25rem", { lineHeight: "1.75rem", letterSpacing: "-0.01em" }],
        "2xl": ["1.5rem", { lineHeight: "2rem", letterSpacing: "-0.018em" }],
        "3xl": ["1.875rem", { lineHeight: "2.25rem", letterSpacing: "-0.022em" }],
        "4xl": ["2.25rem", { lineHeight: "2.5rem", letterSpacing: "-0.026em" }],
      },

      colors: {
        border: {
          DEFAULT: "hsl(var(--border))",
          strong: "hsl(var(--border-strong))",
        },
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        // The signature indigo→cyan. Separate from `accent` on purpose: `accent` is the
        // neutral hover surface shadcn's ghost/outline variants reach for, and when brand
        // colour lived there every ghost button lit up cyan on hover.
        brand: {
          DEFAULT: "hsl(var(--brand))",
          2: "hsl(var(--brand-2))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        // A four-step status ramp (good → warning → serious → critical). Named "confidence" for
        // the score tiers it was built for; those are gone with `matching_score`, but the ramp
        // outlived them — badges, callouts and the console all mean severity by it.
        confidence: {
          high: "hsl(var(--confidence-high))",
          good: "hsl(var(--confidence-good))",
          medium: "hsl(var(--confidence-medium))",
          low: "hsl(var(--confidence-low))",
        },
        // The categorical chart palette — identity, in fixed order. `chart-1` is always the first
        // series and `chart-2` the second; a filter that drops one must never repaint the other.
        // Separate from `confidence` on purpose: that ramp means severity, and a series borrowing
        // a status colour would say something about the data it does not mean.
        chart: {
          1: "hsl(var(--chart-1))",
          2: "hsl(var(--chart-2))",
          3: "hsl(var(--chart-3))",
        },
      },

      backgroundImage: {
        "gradient-brand": "linear-gradient(135deg, hsl(var(--brand)), hsl(var(--brand-2)))",
      },

      // Driven by tokens so dark mode can swap drop shadows for something that doesn't
      // read as mud on a near-black canvas.
      boxShadow: {
        xs: "var(--shadow-xs)",
        sm: "var(--shadow-sm)",
        DEFAULT: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
        none: "none",
      },

      borderRadius: {
        xl: "calc(var(--radius) + 4px)",
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },

      // One easing for the whole app. `swift` is the decelerate curve every panel, popover
      // and page transition uses, so motion feels like it comes from one hand.
      transitionTimingFunction: {
        swift: "cubic-bezier(0.32, 0.72, 0, 1)",
      },
      transitionDuration: {
        fast: "120ms",
        DEFAULT: "180ms",
        slow: "280ms",
      },

      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        shimmer: {
          "0%": { backgroundPosition: "200% 0" },
          "100%": { backgroundPosition: "-200% 0" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "fade-up": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s cubic-bezier(0.32, 0.72, 0, 1)",
        "accordion-up": "accordion-up 0.2s cubic-bezier(0.32, 0.72, 0, 1)",
        shimmer: "shimmer 1.6s ease-in-out infinite",
        "fade-in": "fade-in 0.2s cubic-bezier(0.32, 0.72, 0, 1)",
        "fade-up": "fade-up 0.28s cubic-bezier(0.32, 0.72, 0, 1)",
      },
    },
  },
  plugins: [require("tailwindcss-animate"), require("@tailwindcss/forms")],
};

export default config;
