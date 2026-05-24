export default {
  title: 'Components/Card',
  tags: ['autodocs'],
};

export const DefaultCard = () => (
  <div className="card">
    <p>This is a default card with standard padding.</p>
  </div>
);

export const CardWithTitle = () => (
  <div className="card">
    <h4 className="card-title">Card Title</h4>
    <p>Card content goes here.</p>
  </div>
);

export const CardLargePadding = () => (
  <div className="card card-pad-lg">
    <p>This card has larger padding for a more spacious layout.</p>
  </div>
);

export const CardWithContent = () => (
  <div className="card">
    <h4 className="card-title">Revenue Information</h4>
    <div className="rev-card">
      <span className="rev-big">$50B</span>
      <div className="rev-range">$45B - $55B</div>
      <div className="rev-foot">
        <span>Based on public data</span>
      </div>
    </div>
  </div>
);

export const Banner = () => (
  <div className="banner banner-info">
    <span className="banner-icon">ℹ️</span>
    <span>This is an informational banner message</span>
  </div>
);

export const BannerVariants = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
    <div className="banner banner-info">
      <span className="banner-icon">ℹ️</span>
      <span>Information message</span>
    </div>
    <div className="banner banner-warning">
      <span className="banner-icon">⚠️</span>
      <span>Warning message</span>
    </div>
    <div className="banner banner-danger">
      <span className="banner-icon">❌</span>
      <span>Error message</span>
    </div>
    <div className="banner banner-success">
      <span className="banner-icon">✓</span>
      <span>Success message</span>
    </div>
  </div>
);
