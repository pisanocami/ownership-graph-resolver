export default {
  title: 'Components/Button',
  tags: ['autodocs'],
};

export const Default = () => (
  <button className="btn">Default Button</button>
);

export const Primary = () => (
  <button className="btn btn-primary">Primary Button</button>
);

export const Ghost = () => (
  <button className="btn btn-ghost">Ghost Button</button>
);

export const Small = () => (
  <button className="btn btn-sm">Small Button</button>
);

export const IconButton = () => (
  <button className="btn btn-icon">⚙️</button>
);

export const DisabledState = () => (
  <button className="btn" disabled>Disabled Button</button>
);

export const AllVariants = () => (
  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
    <button className="btn">Default</button>
    <button className="btn btn-primary">Primary</button>
    <button className="btn btn-ghost">Ghost</button>
    <button className="btn btn-sm">Small</button>
    <button className="btn btn-icon">⚙️</button>
    <button className="btn" disabled>Disabled</button>
  </div>
);
