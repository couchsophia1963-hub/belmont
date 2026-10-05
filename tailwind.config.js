/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#eef6ff',
          100: '#d9eaff',
          200: '#bcd9ff',
          300: '#8ec1ff',
          400: '#5a9ff7',
          500: '#2f80ed',
          600: '#1e6fd4',
          700: '#1859b0',
          800: '#194d8f',
          900: '#123a73',
        },
        accent: {
          50: '#fef5e7',
          100: '#fce8c4',
          500: '#e8a317',
          600: '#d18b0e',
          700: '#a96f0a',
        },
        success: {
          500: '#22c55e',
          600: '#16a34a',
          700: '#15803d',
        },
        warning: {
          500: '#f59e0b',
          600: '#d97706',
        },
        error: {
          500: '#ef4444',
          600: '#dc2626',
          700: '#b91c1c',
        },
      },
      fontFamily: {
        serif: ['Playfair Display', 'Georgia', 'serif'],
        sans: ['Source Sans 3', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
