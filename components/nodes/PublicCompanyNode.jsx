import { Handle, Position } from 'reactflow';
import { formatUSD } from '../../synth.js';

export default function PublicCompanyNode({ data, selected }) {
  const { node, role, onSelect } = data;
  const rev = node.revenue_estimate;
  const isFocal = role === 'focal';
  const handleStyle = { background: 'transparent', border: 'none', width: 1, height: 1 };
  const ticker = node.ticker || node.exchange_ticker;

  return (
    <div
      className={`flow-node public-company ${isFocal ? 'focal' : ''} ${selected ? 'selected' : ''}`}
      onClick={() => onSelect?.(node.company)}
      style={{ position: 'relative' }}
    >
      <Handle type="target" position={Position.Top} style={handleStyle} />
      {ticker && (
        <div style={{
          position: 'absolute',
          top: 4,
          right: 6,
          backgroundColor: 'var(--accent)',
          color: 'white',
          padding: '2px 6px',
          borderRadius: 3,
          fontSize: 9,
          fontWeight: 600,
        }}>
          {ticker}
        </div>
      )}
      <div className="flow-node-name">{node.company}</div>
      <div className="flow-node-meta">
        <span className={`chip ${isFocal ? 'chip-accent' : ''}`}>{role}</span>
        {rev && rev.central > 0 && (
          <>
            <span className={`confidence-dot confidence-${rev.confidence || 'low'}`} />
            <span className="flow-node-rev">{formatUSD(rev.central)}</span>
          </>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} style={handleStyle} />
    </div>
  );
}
