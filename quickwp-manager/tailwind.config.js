/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // The dark frame around the content sheet.
        chrome: '#1e1e1e',
        // WordPress admin blue, for the one primary action on a screen.
        wp: {
          blue: '#3858e9',
          'blue-dark': '#2145e6',
        },
        primary: {
          50: '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          300: '#93c5fd',
          400: '#60a5fa',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
          800: '#1e40af',
          900: '#1e3a8a',
        },
        gray: {
          50: '#f9fafb',
          100: '#f3f4f6',
          200: '#e5e7eb',
          300: '#d1d5db',
          400: '#9ca3af',
          500: '#6b7280',
          600: '#4b5563',
          700: '#374151',
          800: '#1f2937',
          900: '#111827',
        }
      },
      fontFamily: {
        // The platform's own UI font, so the app reads as native.
        sans: ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'system-ui', 'sans-serif'],
      },
      animation: {
        'fade-in': 'fadeIn 0.2s ease-in-out',
        'slide-up': 'slideUp 0.3s ease-out',
        'preview-load': 'previewLoad 1.1s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(10px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        // The site preview's loading bar, sweeping under its toolbar.
        previewLoad: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(300%)' },
        },
      },
    },
  },
  plugins: [
    require('@tailwindcss/forms'),
    // Breakpoints for a site's tabs, measured on the details pane rather than
    // the window: beside the live preview the pane is a fraction of it.
    // Where container queries are unsupported the one-column base applies.
    require('tailwindcss/plugin')(({ addVariant }) => {
      addVariant('pane-sm', '@container (min-width: 440px)');
      addVariant('pane-lg', '@container (min-width: 760px)');
      addVariant('pane-xl', '@container (min-width: 1000px)');
    }),
  ],
}
