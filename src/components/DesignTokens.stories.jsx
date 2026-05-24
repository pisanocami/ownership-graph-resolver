export default {
  title: 'Design System/Tokens',
  tags: ['autodocs'],
};

const fontSizes = [
  { token: '--text-xs', size: '10px', use: 'Chip labels, field labels' },
  { token: '--text-sm', size: '11px', use: 'Secondary text, hints' },
  { token: '--text-base', size: '13px', use: 'Button text, components' },
  { token: '--text-md', size: '14px', use: 'Body text (default)' },
  { token: '--text-lg', size: '16px', use: 'Heading 3, brand title' },
  { token: '--text-xl', size: '18px', use: 'Column title' },
  { token: '--text-2xl', size: '22px', use: 'Detail panel name' },
  { token: '--text-3xl', size: '26px', use: 'Large revenue display' },
];

const spacing = [
  { token: '--space-1', size: '2px', use: 'Fine micro spacing' },
  { token: '--space-1_5', size: '4px', use: 'Component gaps' },
  { token: '--space-2', size: '6px', use: 'Tight padding' },
  { token: '--space-2_5', size: '8px', use: 'Standard small' },
  { token: '--space-3', size: '10px', use: 'Form padding' },
  { token: '--space-3_5', size: '12px', use: 'Component gaps' },
  { token: '--space-4', size: '14px', use: 'Medium spacing' },
  { token: '--space-5', size: '16px', use: 'Standard padding' },
];

export const Typography = () => (
  <div style={{ padding: 'var(--space-8)' }}>
    <h2>Typography Scale</h2>
    <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 'var(--space-5)' }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--border)' }}>
          <th style={{ textAlign: 'left', padding: 'var(--space-3)', fontSize: 'var(--text-sm)' }}>Token</th>
          <th style={{ textAlign: 'left', padding: 'var(--space-3)', fontSize: 'var(--text-sm)' }}>Size</th>
          <th style={{ textAlign: 'left', padding: 'var(--space-3)', fontSize: 'var(--text-sm)' }}>Use Case</th>
          <th style={{ textAlign: 'left', padding: 'var(--space-3)', fontSize: 'var(--text-sm)' }}>Example</th>
        </tr>
      </thead>
      <tbody>
        {fontSizes.map((item) => (
          <tr key={item.token} style={{ borderBottom: '1px solid var(--border)' }}>
            <td style={{ padding: 'var(--space-3)', fontSize: 'var(--text-sm)' }}>
              <code>{item.token}</code>
            </td>
            <td style={{ padding: 'var(--space-3)', fontSize: 'var(--text-sm)' }}>{item.size}</td>
            <td style={{ padding: 'var(--space-3)', fontSize: 'var(--text-sm)' }}>{item.use}</td>
            <td style={{ padding: 'var(--space-3)', fontSize: `var(${item.token})` }}>
              The quick brown fox
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export const Spacing = () => (
  <div style={{ padding: 'var(--space-8)' }}>
    <h2>Spacing Scale</h2>
    <div style={{ marginTop: 'var(--space-5)' }}>
      {spacing.map((item) => (
        <div key={item.token} style={{ marginBottom: 'var(--space-5)' }}>
          <div style={{ fontSize: 'var(--text-sm)', marginBottom: 'var(--space-2)' }}>
            <strong>{item.token}</strong> — {item.size} ({item.use})
          </div>
          <div
            style={{
              backgroundColor: 'var(--accent)',
              height: item.size,
              borderRadius: 'var(--radius-md)',
            }}
          />
        </div>
      ))}
    </div>
  </div>
);

export const BorderRadius = () => (
  <div style={{ padding: 'var(--space-8)' }}>
    <h2>Border Radius</h2>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-5)', marginTop: 'var(--space-5)' }}>
      {[
        { token: '--radius-xs', size: '2px', label: 'XS' },
        { token: '--radius-sm', size: '4px', label: 'SM' },
        { token: '--radius-md', size: '6px', label: 'MD' },
        { token: '--radius-lg', size: '8px', label: 'LG' },
        { token: '--radius-xl', size: '10px', label: 'XL' },
      ].map((item) => (
        <div key={item.token}>
          <div
            style={{
              backgroundColor: 'var(--accent)',
              height: '80px',
              borderRadius: `var(${item.token})`,
              marginBottom: 'var(--space-3)',
            }}
          />
          <code style={{ fontSize: 'var(--text-xs)' }}>{item.token}</code>
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', margin: '4px 0 0' }}>
            {item.label} ({item.size})
          </p>
        </div>
      ))}
    </div>
  </div>
);

export const Colors = () => (
  <div style={{ padding: 'var(--space-8)' }}>
    <h2>Color Palette</h2>
    <div style={{ marginTop: 'var(--space-5)' }}>
      <h3>Light Theme</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 'var(--space-4)', marginTop: 'var(--space-4)' }}>
        <div>
          <div style={{ backgroundColor: '#0891b2', height: '60px', borderRadius: 'var(--radius-md)', marginBottom: 'var(--space-2)' }} />
          <p style={{ fontSize: 'var(--text-xs)', margin: '0' }}>--accent</p>
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', margin: '0' }}>#0891b2</p>
        </div>
        <div>
          <div style={{ backgroundColor: '#16a34a', height: '60px', borderRadius: 'var(--radius-md)', marginBottom: 'var(--space-2)' }} />
          <p style={{ fontSize: 'var(--text-xs)', margin: '0' }}>--success</p>
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', margin: '0' }}>#16a34a</p>
        </div>
        <div>
          <div style={{ backgroundColor: '#b45309', height: '60px', borderRadius: 'var(--radius-md)', marginBottom: 'var(--space-2)' }} />
          <p style={{ fontSize: 'var(--text-xs)', margin: '0' }}>--warning</p>
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', margin: '0' }}>#b45309</p>
        </div>
        <div>
          <div style={{ backgroundColor: '#b91c1c', height: '60px', borderRadius: 'var(--radius-md)', marginBottom: 'var(--space-2)' }} />
          <p style={{ fontSize: 'var(--text-xs)', margin: '0' }}>--danger</p>
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', margin: '0' }}>#b91c1c</p>
        </div>
      </div>
    </div>
  </div>
);
