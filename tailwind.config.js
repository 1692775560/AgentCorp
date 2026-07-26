/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
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
