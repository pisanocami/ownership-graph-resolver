export default {
  title: 'Components/Chip',
  tags: ['autodocs'],
};

export const Default = () => (
  <span className="chip">Default Chip</span>
);

export const Accent = () => (
  <span className="chip chip-accent">Accent Chip</span>
);

export const Warning = () => (
  <span className="chip chip-warning">Warning Chip</span>
);

export const Danger = () => (
  <span className="chip chip-danger">Danger Chip</span>
);

export const AllVariants = () => (
  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
    <span className="chip">Neutral</span>
    <span className="chip chip-accent">Accent</span>
    <span className="chip chip-warning">Warning</span>
    <span className="chip chip-danger">Danger</span>
  </div>
);

export const ConfidenceDot = () => (
  <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
      <span className="confidence-dot confidence-high"></span>
      <span>High</span>
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
      <span className="confidence-dot confidence-medium"></span>
      <span>Medium</span>
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
      <span className="confidence-dot confidence-low"></span>
      <span>Low</span>
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
      <span className="confidence-dot confidence-unknown"></span>
      <span>Unknown</span>
    </div>
  </div>
);

export const ChipsInContext = () => (
  <div style={{ padding: '12px' }}>
    <h4>Ownership Classifications</h4>
    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' }}>
      <span className="chip chip-accent">focal</span>
      <span className="chip chip-warning">PE</span>
      <span className="chip chip-danger">divesting</span>
      <span className="chip">public company</span>
    </div>
  </div>
);
