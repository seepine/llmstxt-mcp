export default {
  '*.{js,jsx,ts,tsx,md,json}': ['prettier --write'],
  'src/**/*.{ts,tsx}': [() => 'pnpm check'],
}
