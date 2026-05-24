import '../styles.css';

export const parameters = {
  actions: { argTypesRegex: '^on[A-Z].*' },
  controls: {
    matchers: {
      color: /(background|color)$/i,
      date: /Date$/i,
    },
  },
};

// Dark mode support
export const decorators = [
  (Story) => (
    <div style={{ padding: '20px', fontFamily: 'Inter, sans-serif', backgroundColor: 'var(--bg)', color: 'var(--text)' }}>
      <Story />
    </div>
  ),
];
