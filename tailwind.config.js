/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // shadcn 语义色：与 globals.css 中的 --xxx HSL 变量一一对应。
        // 此前缺失导致 border-border / bg-background / text-foreground 等
        // 工具类在 vite build 的 postcss 阶段报 "class does not exist"。
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        brand: {
          DEFAULT: "#2f6df6",
          dark: "#1b4fc4",
        },
        mvp: "#16a34a",
        observe: "#d97706",
        fired: "#dc2626",
      },
      fontFamily: {
        sans: ["system-ui", "PingFang SC", "Microsoft YaHei", "sans-serif"],
      },
    },
  },
  plugins: [],
};
