import { Handle, Position } from 'reactflow';

export default function IndividualNode({ data, selected }) {
  const { node, role, onSelect } = data;
  const rev = node.revenue_estimate;
  const isFocal = role === 'focal';
  const handleStyle = { background: 'transparent', border: 'none', width: 1, height: 1 };

  return (
    <div
      className={`flow-node individual ${isFocal ? 'focal' : ''} ${selected ? 'selected' : ''}`}
      onClick={() => onSelect?.(node.company)}
      style={{
        borderStyle: 'dashed',
        borderColor: isFocal ? 'var(--accent)' : 'var(--accent-soft-border)',
      }}
    >
      <Handle type="target" position={Position.Top} style={handleStyle} />
      <div className="flow-node-name" style={{ fontStyle: 'italic' }}>
        ◉ {node.company}
      </div>
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
